import type { SessionData } from "../hooks/useAgentSession";
import type { SessionViewSnapshot } from "./session-view-cache";
import type { SessionInfo } from "./types";
import { normalizeToolCalls } from "./normalize";

export interface BackgroundSessionRefreshInputs {
  sessions: readonly SessionInfo[];
  runningSessionIds: ReadonlySet<string>;
  selectedSessionId: string | null;
}

type SnapshotInput = Omit<SessionViewSnapshot, "savedAt"> & { toolNames?: string[] };

export interface SessionViewPrefetchDependencies {
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
  cache: {
    /** TTL-aware, identity-preserving read, without an LRU touch. */
    peek: (id: string) => SessionViewSnapshot | null;
    set: (snapshot: SnapshotInput, protectedSessionId?: string | null) => boolean;
    delete: (id: string) => void;
    /** Touch only the foreground snapshot before a background insert can evict it. */
    protect: (id: string) => void;
  };
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export const SESSION_VIEW_REFRESH_MS = 5_000;
const MAX_TARGETS = 6;
const MAX_CONCURRENT = 2;
const REQUEST_TIMEOUT_MS = 15_000;
const COMPLETION_TTL_MS = 10 * 60_000;
const MAX_COMPLETION_ATTEMPTS = 3;

interface Completion {
  expiresAt: number;
  nextAttemptAt: number;
  attempts: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

/** Validate only the confirmed-history envelope; never accept a run/state payload. */
function isSessionData(value: unknown, id: string): value is SessionData {
  if (!object(value) || value.sessionId !== id || "error" in value
    || value.treeFormat !== "summary" || !Array.isArray(value.tree)
    || typeof value.snapshotRevision !== "string" || !value.snapshotRevision
    || !nullableString(value.leafId)
    || typeof value.totalActiveMs !== "number" || !Number.isFinite(value.totalActiveMs)
    || (value.toolNames !== undefined && !strings(value.toolNames))) return false;
  const context = value.context;
  return object(context) && Array.isArray(context.messages)
    && context.messages.every((message) => object(message) && typeof message.role === "string")
    && strings(context.entryIds) && context.entryIds.length === context.messages.length
    && nullableString(context.oldestEntryId) && typeof context.hasMore === "boolean"
    && (context.turnsBefore === undefined || (typeof context.turnsBefore === "number"
      && Number.isFinite(context.turnsBefore) && context.turnsBefore >= 0))
    && typeof context.thinkingLevel === "string"
    && (context.model === null || (object(context.model)
      && typeof context.model.provider === "string" && typeof context.model.modelId === "string"));
}

/**
 * Read-only, page-memory warming. No catalog/running requests, SSE, wrappers,
 * prompts, or React state. All writes use a compare-by-object-identity guard.
 * A cycle has at most six targets and two workers; regular cycles are 5 s apart.
 * Completion reads bypass that cadence once, then retry at most three times,
 * with a 10-minute TTL (including time hidden/offline).
 */
export class SessionViewPrefetchController {
  private readonly now;
  private readonly setTimer;
  private readonly clearTimer;
  private catalog = new Map<string, SessionInfo>();
  private running = new Set<string>();
  private selected: string | null = null;
  private completions = new Map<string, Completion>();
  private lastRequested = new Map<string, number>();
  private requests = new Map<string, AbortController>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private visible = true;
  private online = true;
  private generation = 0;
  private cycling = false;
  private nextRegularAt = 0;

  constructor(private readonly dependencies: SessionViewPrefetchDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    // Do not install a raw browser method on this controller: calling it as
    // this.clearTimer(...) gives Web IDL the controller, not the Window receiver.
    this.clearTimer = dependencies.clearTimer ?? ((timer) => globalThis.clearTimeout(timer));
  }

  /** Restartable so React Strict Mode's setup/cleanup/setup does not strand it. */
  start(): void {
    this.enabled = true;
    this.schedule();
  }

  stop(): void {
    this.enabled = false;
    this.generation++;
    this.cancelTimer();
    for (const request of this.requests.values()) request.abort();
  }

  update(inputs: BackgroundSessionRefreshInputs): void {
    this.catalog = new Map(inputs.sessions.map((session) => [session.id, session]));
    this.selected = inputs.selectedSessionId;
    const running = new Set(inputs.runningSessionIds);
    for (const id of this.running) {
      if (!running.has(id) && id !== this.selected && this.catalog.get(id)?.relation?.kind !== "subagent") {
        this.completions.set(id, {
          expiresAt: this.now() + COMPLETION_TTL_MS, nextAttemptAt: 0, attempts: 0,
        });
      }
    }
    this.running = running;
    for (const id of this.completions.keys()) {
      if (running.has(id) || id === this.selected || this.catalog.get(id)?.relation?.kind === "subagent") {
        this.completions.delete(id);
      }
    }
    this.prune();
    for (const [id, request] of this.requests) {
      if (!this.candidate(id)) request.abort();
    }
    this.schedule();
  }

  setEnvironment(environment: { visible: boolean; online: boolean }): void {
    const wasAvailable = this.available();
    this.visible = environment.visible;
    this.online = environment.online;
    if (!this.available()) {
      if (wasAvailable) this.generation++;
      this.cancelTimer();
      for (const request of this.requests.values()) request.abort();
    } else {
      this.schedule();
    }
  }

  private available(): boolean {
    return this.enabled && this.visible && this.online;
  }

  private candidate(id: string): boolean {
    return id !== this.selected && this.catalog.has(id)
      && this.catalog.get(id)?.relation?.kind !== "subagent"
      && (this.running.has(id) || this.completions.has(id));
  }

  private prune(): void {
    const now = this.now();
    for (const [id, completion] of this.completions) {
      if (completion.expiresAt <= now || completion.attempts >= MAX_COMPLETION_ATTEMPTS) {
        this.completions.delete(id);
      }
    }
    // No per-id bookkeeping for unrelated idle history.
    for (const id of this.lastRequested.keys()) {
      if (!this.running.has(id) && !this.completions.has(id) && !this.requests.has(id)) {
        this.lastRequested.delete(id);
      }
    }
  }

  private dueAt(id: string): number {
    const completion = this.completions.get(id);
    // First final read must not be satisfied by a request started BEFORE completion.
    if (completion) return completion.nextAttemptAt;
    return Math.max(this.nextRegularAt, (this.lastRequested.get(id) ?? -Infinity) + SESSION_VIEW_REFRESH_MS);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.cancelTimer();
    if (!this.available() || this.cycling) return;
    this.prune();
    let next = Infinity;
    for (const id of this.catalog.keys()) {
      if (this.candidate(id)) next = Math.min(next, this.dueAt(id));
    }
    if (!Number.isFinite(next)) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.cycle();
    }, Math.max(0, next - this.now()));
  }

  private async cycle(): Promise<void> {
    if (!this.available() || this.cycling) return;
    this.prune();
    const now = this.now();
    const targets = [...this.catalog.keys()]
      .filter((id) => this.candidate(id) && this.dueAt(id) <= now)
      .sort((a, b) => Number(this.completions.has(b)) - Number(this.completions.has(a))
        || (this.lastRequested.get(a) ?? -Infinity) - (this.lastRequested.get(b) ?? -Infinity))
      .slice(0, MAX_TARGETS);
    if (!targets.length) { this.schedule(); return; }
    if (targets.some((id) => !this.completions.has(id))) this.nextRegularAt = now + SESSION_VIEW_REFRESH_MS;
    const generation = this.generation;
    this.cycling = true;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length && this.available() && generation === this.generation) {
        const id = targets[cursor++];
        if (this.candidate(id)) await this.refresh(id, generation);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, targets.length) }, worker));
    } finally {
      this.cycling = false;
      this.schedule();
    }
  }

  private async refresh(id: string, generation: number): Promise<void> {
    const cache = this.dependencies.cache;
    const expected = cache.peek(id);
    const completion = this.completions.get(id);
    const controller = new AbortController();
    this.requests.set(id, controller);
    this.lastRequested.set(id, this.now());
    if (completion) completion.nextAttemptAt = this.now() + SESSION_VIEW_REFRESH_MS;
    const timeout = this.setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // Selection/catalog changes abort even if the user switches away again before
    // the reply arrives. Foreground mounts writing a newer cache object also win.
    const valid = () => this.available() && generation === this.generation
      && !controller.signal.aborted && this.candidate(id) && cache.peek(id) === expected;
    let confirmed = false;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", tree: "summary" });
      if (expected) params.set("knownRevision", expected.revision);
      const response = await this.dependencies.fetch(`/api/sessions/${encodeURIComponent(id)}?${params}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!valid()) return;
      if (response.status === 404) {
        cache.delete(id);
        confirmed = true;
        return;
      }
      if (!response.ok) return;
      const data: unknown = await response.json();
      if (!valid()) return;
      if (object(data) && data.sessionId === id && data.unchanged === true && !("error" in data)) {
        if (expected && data.snapshotRevision === expected.revision) {
          this.store(expected, expected);
          confirmed = true;
        }
        return;
      }
      if (!isSessionData(data, id)) return;
      confirmed = true;
      if (expected && expected.revision !== data.snapshotRevision
        && Math.max(expected.entryIds.length, expected.loadedEntryIds.length) > 50
        && data.context.entryIds.length < Math.max(expected.entryIds.length, expected.loadedEntryIds.length)) {
        // Do not silently collapse a user-paged window. Its old revision remains
        // honest; the foreground loader can reconcile it when the user returns.
        return;
      }
      const sameRevision = expected !== null && expected.revision === data.snapshotRevision;
      this.store({
        sessionId: id, revision: data.snapshotRevision!,
        messages: sameRevision ? expected.messages : data.context.messages.map(normalizeToolCalls),
        entryIds: sameRevision ? expected.entryIds : data.context.entryIds,
        leafId: data.leafId,
        oldestEntryId: sameRevision ? expected.oldestEntryId : data.context.oldestEntryId,
        hasMore: sameRevision ? expected.hasMore : data.context.hasMore,
        turnsBefore: sameRevision ? expected.turnsBefore : data.context.turnsBefore ?? 0,
        summaryTree: data.tree, thinkingLevel: data.context.thinkingLevel,
        model: data.context.model, stats: data.stats, totalActiveMs: data.totalActiveMs,
        loadedEntryIds: sameRevision ? expected.loadedEntryIds : data.context.entryIds,
        toolNames: data.toolNames,
      }, expected);
    } catch {
      // Best effort only. Do not log response bodies, prompts, or conversation text.
    } finally {
      this.clearTimer(timeout);
      this.requests.delete(id);
      if (completion && this.completions.get(id) === completion) {
        if (confirmed) this.completions.delete(id);
        else if (!this.available() || generation !== this.generation || controller.signal.aborted) {
          // Pauses/selection invalidation aren't failed completion attempts. A
          // timeout while still available is retried on the ordinary cooldown.
          if (!this.available() || generation !== this.generation) completion.nextAttemptAt = 0;
          else completion.attempts++;
        } else completion.attempts++;
      }
    }
  }

  private store(snapshot: SnapshotInput | SessionViewSnapshot, previous: SessionViewSnapshot | null): void {
    const cache = this.dependencies.cache;
    if (this.selected) cache.protect(this.selected);
    // Never carry an old savedAt into a refresh; the cache owns timestamping.
    const { savedAt: _savedAt, ...fields } = snapshot as SessionViewSnapshot & { toolNames?: string[] };
    void _savedAt;
    if (!cache.set(fields, this.selected) && previous && cache.peek(snapshot.sessionId) === null) {
      // The existing cache writer can remove the old entry before refusing an
      // oversized replacement. Restore last good history rather than lose it.
      const { savedAt: _previousSavedAt, ...oldFields } = previous;
      void _previousSavedAt;
      cache.set(oldFields, this.selected);
    }
  }
}

export function createSessionViewPrefetchController(dependencies: SessionViewPrefetchDependencies): SessionViewPrefetchController {
  return new SessionViewPrefetchController(dependencies);
}
