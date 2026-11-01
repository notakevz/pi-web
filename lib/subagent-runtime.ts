import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import { createLocalSubagentServices } from "./local-subagent-services";
import {
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  readSubagentSessionResources,
  getAllSubagentProfiles,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  settleOrphanedSubagentStatus,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import type { DebugParentNotification, DebugSubagentRun } from "./debug-types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { appendSubagentInputFiles, loadSubagentInputFiles, subagentInputLimits } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { createSubagentCodemodeExtension, createSubagentMcpExtensions } from "./builtin-extensions";
import type { McpHost } from "./mcp-host";
import { createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { serializeByKey } from "./key-serializer";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { readSessionToolSelection } from "./session-tool-selection";
import {
  assertLocalSubagentContinuation, createLocalSubagentPolicy, createLocalSubagentPolicyExtension,
  filterLocalSubagentProfiles, localSubagentMode,
} from "./local-subagent-policy";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  /** Host Stop's synchronous admission barrier, not a foreground tool wait's signal. */
  isStopping?(): boolean;
  waitUntilReady(): Promise<void>;
  /**
   * Connect the session's MCP servers before a run prompts the SDK session directly, past the
   * wrapper's `send()`; false when Stop or `signal` ended the wait and the run must not start.
   */
  prepareMcpForRun?(signal: AbortSignal): Promise<boolean>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: () => string; chatOnly?: boolean; mcpHost?: McpHost },
  ): HostSession | void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string, parentContext?: ExtensionContext): Promise<void>;
  abort(sessionId: string): Promise<void>;
  /** Host Stop's descendant broadcast/unwind; abort the owner's SDK session concurrently. */
  abortFamily(sessionId: string): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  /** Host Stop suppresses this run's background/expired-wait completion report. */
  suppressParentNotification?: boolean;
  /** Set once the turn limit ends the run; later steering is refused instead of starting another turn. */
  turnLimitReached?: boolean;
  cancelQueued?: () => boolean;
  /** Ends the wait for the child's MCP servers before its prompt (`prepareChildMcp()`). */
  mcpWait?: AbortController;
  /**
   * When this run (or resume) entered the run map, for the debug panel: a resumed run keeps the
   * first run's `createdAt`. Absent on a run stored before a hot reload.
   */
  dispatchedAt?: number;
};

/** A run's completion `notifyParent()` is delivering; `since` is absent on one added before a hot reload. */
type ParentNotification = Pick<SubagentRunInfo, "sessionId" | "parentSessionId" | "completedAt"> & {
  since?: number;
  cancelled?: boolean;
  /** Preserve suppression if this same completion is offered again after Stop. */
  completionRun?: SubagentRunInfo;
  notificationId?: string;
  submitted?: boolean;
  dispatched?: boolean;
  isSuppressed?: () => boolean;
  onDispatched?: () => void;
  unsubscribe?: () => void;
};

type SubagentAdmission = {
  parentSessionId: string;
  cancelled: boolean;
  completion: Promise<void>;
  finish(): void;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
  var __piSubagentParentNotifications: Set<ParentNotification> | undefined;
  var __piSubagentAdmissions: Set<SubagentAdmission> | undefined;
  var __piSubagentStoppedResults: WeakSet<SubagentRunInfo> | undefined;
  var __piSubagentStoppingFamily: Map<string, number> | undefined;
  var __piSubagentParents: Map<string, string> | undefined;
  var __piSubagentNotificationTokens: Map<string, ParentNotification> | undefined;
}
const RESUME_ADMISSION_LOCK = Symbol.for("pi-web.subagent-resume-admission");
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_POLL_MS = 200;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

/**
 * How the last model request ended when `prompt()` resolved anyway: pi records a provider
 * failure, or a request stopped from the child's own chat, on the assistant message.
 */
function lastAssistantStop(sessionManager: { getEntries?: () => unknown }): { aborted?: true; error?: string } | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted") return { aborted: true };
    if (entry.message.stopReason !== "error") return undefined;
    return { error: typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error" };
  }
  return undefined;
}

function turnLimitError(turnLimit: number, undelivered: readonly string[]): string {
  const error = `Subagent reached its turn limit (${turnLimit}) without completing the task.`;
  if (undelivered.length === 0) return error;
  return `${error} These queued messages were not delivered:\n${undelivered.map((text) => `- ${text}`).join("\n")}`;
}

/**
 * A child with `mcp: on` connects its servers before its prompt, as a prompt sent to the wrapper
 * does. The parent's Stop and `abort()` end the wait through `stored.mcpWait`, the child's own
 * Stop through the wrapper; either way the run is aborted before it starts.
 */
async function prepareChildMcp(session: HostSession | void, stored: StoredSubagentExecution): Promise<void> {
  if (!session?.prepareMcpForRun) return;
  const controller = new AbortController();
  stored.mcpWait = controller;
  try {
    if (stored.abortRequested) controller.abort();
    if (await session.prepareMcpForRun(controller.signal)) return;
  } finally {
    stored.mcpWait = undefined;
  }
  stored.abortRequested = true;
  throw new Error("Stopped while connecting MCP servers");
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

/**
 * Take a run out of the run map unless a newer run of that session took its place; true when it
 * was still there. Runs call it from `finally` too: a throw before the result entry is written (a
 * session file append failing) must not leave it there, where it would read as running and keep
 * `hasUnsettledSubagentRun()` true for its parent until the server restarts.
 */
function dropSubagentRun(sessionId: string, stored: StoredSubagentExecution): boolean {
  const runs = getSubagentRuns();
  if (runs.get(sessionId) !== stored) return false;
  runs.delete(sessionId);
  return true;
}

/**
 * Runs whose completion `notifyParent()` is still delivering: the run has left the
 * run map, but the parent's turn starts only once the parent is ready and idle. An entry leaves
 * as soon as that turn starts, since the parent is running from then on.
 */
function getParentNotifications(): Set<ParentNotification> {
  globalThis.__piSubagentParentNotifications ??= new Set();
  return globalThis.__piSubagentParentNotifications;
}

/**
 * Runs that can still start a turn in their parent: those in the run map, and notifications
 * not yet delivered whose result the parent has not collected with `get_subagent_result`
 * (`deliverParentNotification()` drops a collected one without a turn).
 */
function unsettledSubagentRuns(): ParentNotification[] {
  const consumed = getConsumedSubagentResults();
  return [
    ...[...getSubagentRuns().values()].map((stored) => stored.run),
    ...[...getParentNotifications()].filter((run) => !run.completedAt || consumed.get(run.sessionId) !== run.completedAt),
  ];
}

/**
 * Whether a subagent run under this session, at any depth, is still unsettled: its end can
 * start a turn there (`notifyParent()`, `triggerTurn`). A run counts from dispatch until its
 * result is written (the run map), then until the turn its parent notification triggers starts,
 * or the delivery is dropped or fails. A hidden page keeps the session's event stream while this
 * holds (#1283), and a main session's run that ends meanwhile announces no completion: the
 * turn a report starts decides that (#1434).
 */
export function hasUnsettledSubagentRun(sessionId: string): boolean {
  const runs = unsettledSubagentRuns();
  const family = subagentFamily(sessionId, runs);
  return runs.some((run) => run.sessionId !== sessionId && family.has(run.sessionId));
}

/** Register persisted ancestry on RPC reopen as well as dispatch; never mutate a run snapshot. */
export function registerSubagentParent(sessionId: string, parentSessionId: string): void {
  if (sessionId === parentSessionId) return;
  (globalThis.__piSubagentParents ??= new Map()).set(sessionId, parentSessionId);
}

/**
 * Completed intermediates still connect their active descendants to the owner. Keep only
 * ancestors of active runs, pending reports, setup admissions or a Stop currently unwinding.
 * Pruning never drops an edge needed by one of those roots, even if that session has settled.
 */
function retainedSubagentParents(): Map<string, string> {
  const parents = globalThis.__piSubagentParents;
  const active = [
    // Read only: a status/debug read must not create these tables.
    ...[...(globalThis.__piSubagentRuns?.values() ?? [])].map((stored) => stored.run),
    // Read, never create: a debug snapshot or a status read must not leave tables behind.
    ...(globalThis.__piSubagentParentNotifications ?? []),
    ...(globalThis.__piSubagentNotificationTokens?.values() ?? []),
  ];
  if (!parents) return new Map();
  for (const run of active) registerSubagentParent(run.sessionId, run.parentSessionId);
  const keep = new Set<string>();
  const seeds = [
    ...active.map((run) => run.sessionId),
    ...[...(globalThis.__piSubagentAdmissions ?? [])].map((admission) => admission.parentSessionId),
    ...(globalThis.__piSubagentStoppingFamily?.keys() ?? []),
  ];
  for (let id of seeds) {
    while (!keep.has(id)) {
      keep.add(id);
      const parent = parents.get(id);
      if (!parent) break;
      id = parent;
    }
  }
  for (const id of parents.keys()) if (!keep.has(id)) parents.delete(id);
  return parents;
}

/** `sessionId` and every session under it, at any depth, by the rows' direct parents. */
function subagentFamily(sessionId: string, runs: readonly Pick<SubagentRunInfo, "sessionId" | "parentSessionId">[]): Set<string> {
  const edges = [
    ...runs,
    ...[...retainedSubagentParents()].map(([sessionId, parentSessionId]) => ({ sessionId, parentSessionId })),
  ];
  const family = new Set([sessionId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const run of edges) {
      if (!family.has(run.parentSessionId) || family.has(run.sessionId)) continue;
      family.add(run.sessionId);
      grew = true;
    }
  }
  return family;
}

/**
 * The run map and the parent notifications for the debug panel: every row, or with a session id
 * the rows under it at any depth (the family `hasUnsettledSubagentRun()` walks). States, flags and
 * times only, never a task, a result, an error or a path. It reads the tables as they are: nothing
 * is created, cancelled or aborted.
 */
export function subagentDebugSnapshot(sessionId?: string): { runs: DebugSubagentRun[]; notifications: DebugParentNotification[] } {
  const stored = [...(globalThis.__piSubagentRuns?.values() ?? [])];
  const pending = [...(globalThis.__piSubagentParentNotifications ?? [])];
  const family = sessionId === undefined
    ? undefined
    : subagentFamily(sessionId, [...stored.map((entry) => entry.run), ...pending]);
  const under = (row: Pick<SubagentRunInfo, "parentSessionId">) => !family || family.has(row.parentSessionId);
  return {
    runs: stored.filter((entry) => under(entry.run)).map((entry) => ({
      sessionId: entry.run.sessionId,
      parentSessionId: entry.run.parentSessionId,
      status: typeof entry.run.status === "string" ? entry.run.status : "unknown",
      profile: typeof entry.run.profile === "string" && entry.run.profile ? entry.run.profile : null,
      background: entry.run.runInBackground === true,
      resumed: entry.run.resumed === true,
      dispatchedAt: typeof entry.dispatchedAt === "number" ? entry.dispatchedAt : null,
      abortRequested: entry.abortRequested === true,
      mcpWaiting: Boolean(entry.mcpWait),
    })),
    notifications: pending.filter(under).map((row) => ({
      sessionId: row.sessionId,
      parentSessionId: row.parentSessionId,
      since: typeof row.since === "number" ? row.since : null,
    })),
  };
}

/** Every session `hasUnsettledSubagentRun()` holds for: the parents of the unsettled runs. */
export function getSessionIdsWithUnsettledSubagentRuns(): string[] {
  const parents = retainedSubagentParents();
  const ids = new Set<string>();
  for (const run of unsettledSubagentRuns()) {
    let id: string | undefined = run.parentSessionId;
    while (id && !ids.has(id)) {
      ids.add(id);
      id = parents.get(id);
    }
  }
  return [...ids];
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. A foreground run whose Agent wait expired
 * also notifies; collecting any terminal run can suppress its report. Each session holds at most
 * one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: SubagentRunIdentity): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return { ...run, status: settleOrphanedSubagentStatus(run.status) };
}

/** The status of a run this process still holds, so a listing does not have to guess from its file. */
export function getLiveSubagentStatus(sessionId: string): SubagentRunInfo["status"] | undefined {
  return getSubagentRuns().get(sessionId)?.run.status;
}

function findSubagentModel(runtime: ModelRuntime, reference: string) {
  const slash = reference.indexOf("/");
  if (slash > 0) return runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = runtime.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/**
 * Reads a model reference as pi's `--model` does: `provider/modelId` or a bare id, optionally
 * followed by `:<thinking level>`. The whole reference is tried first, so an id that itself
 * contains a colon (`qwen3:8b`) still matches; a suffix that is no thinking level never matches.
 */
function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const exact = findSubagentModel(runtime, requested);
  if (exact) return { model: exact };
  const colon = requested.lastIndexOf(":");
  const level = requested.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const model = findSubagentModel(runtime, requested.slice(0, colon));
    if (model) return { model, thinkingLevel: level };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

/**
 * The model the child is expected to run (the call's, else the profile's, else the parent's),
 * looked up early to size `input_files` before a worktree or child session exists (#1199). It
 * never throws: the child's model is resolved for real, and a bad reference refused, only after
 * the child's services have refreshed the shared runtime from models.json and registered its
 * extensions' providers. A reference this lookup misses leaves the files the flat limit.
 */
function expectedSubagentModel(
  runtime: ModelRuntime,
  callModel: string | undefined,
  profileModel: string | undefined,
  parentModel: AgentSessionLike["model"],
) {
  try {
    const reference = callModel?.trim() || profileModel?.trim();
    return reference ? parseSubagentModel(runtime, reference)?.model : parentModel;
  } catch {
    return undefined;
  }
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

/**
 * pi creates a session file only once the session holds a user or assistant message, so a run
 * that ended before its prompt reached the model (stopped while queued or connecting MCP servers,
 * a provider without credentials) kept its metadata and result in memory only. Once the idle
 * child's wrapper was released, `get_subagent_result` and `resume` answered `Subagent not found`
 * for an id the parent had been given, and the session left the sidebar. Write the file when the
 * child is dispatched; `setSessionFile()` reloads it, so pi appends every later entry to it.
 */
function persistChildSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header || existsSync(sessionFile)) return;
  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
  sessionManager.setSessionFile(sessionFile);
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Writes a settled run's result entry, which `readSubagentRun()` reads back, and returns the run as
 * recorded. An isolated run's entry keeps whether its worktree path still exists now, which decides
 * what the parent is told about it, live and read back alike (#1202): a checkout removed during
 * the run is gone though git's removal then failed, and a resumed run removes nothing.
 */
function recordResult(sessionManager: SessionManager, run: SubagentRunInfo): SubagentRunInfo {
  const recorded = run.worktreePath ? { ...run, worktreeExists: existsSync(run.worktreePath) } : run;
  const entry: SubagentResultMetadata = {
    version: 1,
    status: recorded.status as SubagentResultMetadata["status"],
    completedAt: recorded.completedAt!,
    ...(recorded.result ? { result: recorded.result } : {}),
    ...(recorded.error ? { error: recorded.error } : {}),
    ...(recorded.worktreeCleanupError ? { worktreeCleanupError: recorded.worktreeCleanupError } : {}),
    ...(recorded.worktreeExists !== undefined ? { worktreeExists: recorded.worktreeExists } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, entry);
  return recorded;
}

function beginSubagentAdmission(parentSessionId: string): SubagentAdmission {
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => { finish = resolve; });
  const admission = { parentSessionId, cancelled: globalThis.__piSubagentStoppingFamily?.has(parentSessionId) === true, completion, finish };
  (globalThis.__piSubagentAdmissions ??= new Set()).add(admission);
  return admission;
}

function endSubagentAdmission(admission: SubagentAdmission): void {
  globalThis.__piSubagentAdmissions?.delete(admission);
  admission.finish();
}

function assertParentAdmission(parent: HostSession | undefined, admission: SubagentAdmission): asserts parent is HostSession {
  if (admission.cancelled || parent?.isStopping?.() || globalThis.__piSubagentStoppingFamily?.has(admission.parentSessionId)) {
    throw new Error("Parent session is stopping");
  }
  if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
}

function stoppedSubagentResults(): WeakSet<SubagentRunInfo> {
  return globalThis.__piSubagentStoppedResults ??= new WeakSet();
}

/**
 * Install LAST in root/Chat-only and child inline factories. A custom message may be deferred
 * by the SDK while agent_settled handlers run; sendCustomMessage() returning is not dispatch.
 * ctx.abort(), unlike throwing from an extension hook, re-arms SDK cancellation at the real
 * run boundary, after the SDK reset its previous idle abort and before any provider request.
 */
export function createSubagentNotificationCancellationExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      if (event.messageType !== "custom" || event.message.customType !== "pi-web:subagent-notification") return;
      const details = event.message.details as { notificationId?: unknown } | undefined;
      if (typeof details?.notificationId !== "string") return;
      const pending = globalThis.__piSubagentNotificationTokens?.get(details.notificationId);
      if (!pending) return;
      if (pending.cancelled || pending.isSuppressed?.()) ctx.abort();
      pending.onDispatched?.();
    });
  };
}

function childPromptOptions(inner: AgentSessionLike, stored: StoredSubagentExecution) {
  return {
    source: "rpc" as const,
    preflightResult: () => {
      // Input/auth preparation can outlive an idle abort. _startRun is now active: re-arm
      // cancellation permanently for this run before its awaited agent_start/provider call.
      if (stored.abortRequested) void inner.abort().catch(() => undefined);
    },
  };
}

/** Request cancellation only; the caller decides whether to await SDK abort/completion. */
function requestSubagentAbort(stored: StoredSubagentExecution, wrapper: HostSession | undefined): Promise<void> | undefined {
  stored.abortRequested = true;
  if (stored.run.status === "queued") stored.cancelQueued?.();
  else if (stored.mcpWait) stored.mcpWait.abort();
  else return wrapper?.inner.abort();
}

/**
 * Host Stop, not cancellation of a foreground tool's bounded wait. The host must raise its
 * isStopping barrier synchronously, and abort its own SDK run concurrently with this call.
 * Broadcast before awaiting: a child can itself be waiting on a descendant. Never await a
 * notifyParent delivery, which may be waiting for this very parent to idle. In-flight setup
 * admissions stay cancelled even if the host barrier falls before their setup resumes.
 */
export async function abortSubagentFamily(
  parentSessionId: string,
  dependencies: Pick<SubagentRuntimeDependencies, "getSession">,
): Promise<void> {
  const family = subagentFamily(parentSessionId, [
    ...[...getSubagentRuns().values()].map((stored) => stored.run), ...getParentNotifications(),
  ]);
  const stopping = globalThis.__piSubagentStoppingFamily ??= new Map();
  for (const id of family) stopping.set(id, (stopping.get(id) ?? 0) + 1);
  const admissions = [...(globalThis.__piSubagentAdmissions ?? [])]
    .filter((admission) => family.has(admission.parentSessionId));
  for (const admission of admissions) admission.cancelled = true;
  const runs = [...getSubagentRuns().values()].filter((stored) => family.has(stored.run.sessionId));
  // Mark everything before cancellation can synchronously settle a queue/invoke callbacks.
  for (const stored of runs) {
    stored.suppressParentNotification = true;
    stored.abortRequested = true;
  }
  for (const pending of getParentNotifications()) {
    if (!family.has(pending.sessionId) && !family.has(pending.parentSessionId)) continue;
    pending.cancelled = true;
    if (pending.completionRun) stoppedSubagentResults().add(pending.completionRun);
    getParentNotifications().delete(pending);
  }
  const waits: Promise<unknown>[] = admissions.map((admission) => admission.completion);
  for (const stored of runs) {
    // The host owns its own abort/unwind. Waiting for its controller completion here can
    // deadlock when this helper is called from that very run's tool stack.
    if (stored.run.sessionId === parentSessionId) continue;
    waits.push(stored.completion);
    try {
      const abort = requestSubagentAbort(stored, dependencies.getSession(stored.run.sessionId));
      if (abort) waits.push(abort);
    } catch {
      // Continue broadcasting; completion is the authority for actual unwind.
    }
  }
  try { await Promise.allSettled(waits); }
  finally {
    for (const id of family) {
      const count = stopping.get(id)! - 1;
      if (count) stopping.set(id, count);
      else stopping.delete(id);
    }
  }
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  function rememberOwnerAncestry(sessionId: string): void {
    const seen = new Set<string>();
    while (!seen.has(sessionId)) {
      seen.add(sessionId);
      const wrapper = dependencies.getSession(sessionId);
      const entries = wrapper?.inner.sessionManager.getEntries?.() as unknown as SessionEntry[] | undefined;
      const run = entries && readSubagentRun(entries, sessionId, wrapper!.sessionFile);
      if (!run) break;
      registerSubagentParent(sessionId, run.parentSessionId);
      sessionId = run.parentSessionId;
    }
  }

  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const admission = beginSubagentAdmission(request.parentContext.sessionManager.getSessionId());
    try { return await admitStart(request, admission); }
    finally { endSubagentAdmission(admission); }
  }

  async function admitStart(request: StartSubagentRequest, admission: SubagentAdmission): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    rememberOwnerAncestry(parentSessionId);
    const parent = dependencies.getSession(parentSessionId);
    assertParentAdmission(parent, admission);
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      const parentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
      if (readSubagentSessionResources(parentEntries)?.localPolicy) throw new Error("Limited subagents cannot delegate");
      const selection = readSessionToolSelection(parentEntries);
      const mode = localSubagentMode(selection);
      const sourceProfile = filterLocalSubagentProfiles(getAllSubagentProfiles(parent.cwd), selection)
        .find((item) => item.name.toLowerCase() === request.profile.trim().toLowerCase());
      if (!sourceProfile) throw new Error(`Unknown, disabled, or disallowed subagent profile: ${request.profile}`);
      const localPolicy = mode === "plan" || mode === "build" ? createLocalSubagentPolicy(sourceProfile, mode) : undefined;
      // Narrow BEFORE services/resource loading: dropping already imported extensions is too late.
      const profile = localPolicy ? {
        ...sourceProfile, tools: [...localPolicy.builtins], loadExtensions: false, loadSkills: false,
        extensions: undefined, skills: undefined, extensionTools: undefined, disallowedExtensionTools: undefined,
        codemode: "off" as const, mcp: "off" as const,
      } : sourceProfile;

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      // Sized by the window of the model expected to read the copy, and refused before a worktree
      // or child session exists.
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? [], subagentInputLimits(
        expectedSubagentModel(parentModelRuntime, request.model, profile.model, parent.inner.model),
      ));
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const inheritContext = profile.inheritContext;
      // `parseProfileFile` already floors a positive profile `max_turns`, so it is an integer or absent.
      const turnLimit = profile.maxTurns;

      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir);
      if (localPolicy) localPolicy.builtins = resolveShellTools(localPolicy.builtins, settingsManager.getDefaultTools());
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const parentCodemodeEnabled = parent.inner.getActiveToolNames().includes("codemode");
      const wantsCodemode = profile.codemode === "on"
        || (profile.codemode === "inherit" && parentCodemodeEnabled);
      if (promptPlan.chatOnly && profile.codemode === "on") {
        throw new Error("Code mode cannot be enabled for a chat-only subagent profile");
      }
      // A chat-only profile remains chat-only when inheritance is selected. An explicit `on`
      // is rejected above so it cannot silently grant a script capability to tools:none.
      const codemodeEnabled = !promptPlan.chatOnly && wantsCodemode;
      if (promptPlan.chatOnly && profile.mcp === "on") {
        throw new Error("MCP cannot be enabled for a chat-only subagent profile");
      }
      const mcpEnabled = profile.mcp === "on";
      const chatOnly = promptPlan.chatOnly;
      const { appendSystemPrompt, delegatedTask } = promptPlan;
      const skillsBinding = createSubagentSkillsBinding({
        loadSkills: profile.loadSkills,
        skills: profile.skills,
        exactSystemPrompt: promptPlan.exactSystemPrompt,
      });
      const codemodeExtension = codemodeEnabled
        ? await createSubagentCodemodeExtension({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
          })
        : undefined;
      // The policy reads the child's tools once they are resolved below.
      const mcpScope: { tools: readonly string[]; allExtensionTools?: boolean } = { tools: [] };
      const mcp = mcpEnabled
        ? await createSubagentMcpExtensions({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
            codemode: codemodeEnabled,
          })
        : undefined;
      const extensionFactories = [
        ...(codemodeExtension ? [codemodeExtension] : []),
        ...(mcp ? [...mcp.extensions, createSubagentMcpPolicyExtension(() => mcpScope)] : []),
        ...(skillsBinding.loaderOptions.extensionFactories ?? []),
        ...(localPolicy ? [createLocalSubagentPolicyExtension(localPolicy)] : []),
        createSubagentNotificationCancellationExtension(),
      ];
      if (!chatOnly) initTheme();
      const services = await createLocalSubagentServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          ...subagentExtensionLoaderOptions({ ...profile, mcp: mcpEnabled, localPolicy }),
          ...skillsBinding.loaderOptions,
          ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
        },
        ...((profile.loadExtensions || profile.loadSkills || codemodeEnabled || mcpEnabled)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      }, localPolicy);

      if (codemodeEnabled && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
        throw new Error("Code mode is unavailable: builtin:codemode was not registered");
      }

      // `ext:` selectors that `disallowed_tools` cancels out leave an empty list, which admits none.
      const allExtensionTools = profile.loadExtensions && profile.extensionTools === undefined;
      const extensionToolNames = profile.loadExtensions
        ? profile.extensionTools !== undefined
          ? selectSubagentExtensionTools(
            services.resourceLoader.getExtensions().extensions,
            profile.extensionTools,
            profile.disallowedExtensionTools,
          )
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profile.tools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );
      if (localPolicy) {
        // Shell preference resolution is part of the saved builtin ceiling, not an extension grant.
        localPolicy.builtins = [...activeTools];
        if (localPolicy.webfetch) activeTools.push("webfetch");
      }
      if (codemodeEnabled && !activeTools.includes("codemode")) activeTools.push("codemode");
      mcpScope.tools = activeTools;
      mcpScope.allExtensionTools = allExtensionTools;

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          ...(localPolicy ? { localPolicy } : {}),
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          ...(codemodeEnabled ? { codemode: true as const } : {}),
          ...(mcpEnabled ? { mcp: true as const } : {}),
          loadSkills: profile.loadSkills,
          ...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
          loadExtensions: profile.loadExtensions,
          ...(allExtensionTools ? { allExtensionTools: true } : {}),
          ...(profile.extensions !== undefined ? { extensions: [...profile.extensions] } : {}),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      // A `:level` suffix travels with its model. As with pi's `--thinking` over `--model x:level`,
      // the profile's own `thinking` beats a suffix on the profile's model, while a call naming
      // a model with a suffix chose both for this run.
      const callModel = parseSubagentModel(parentModelRuntime, request.model);
      const profileModel = callModel ? undefined : parseSubagentModel(parentModelRuntime, profile.model);
      const thinking = callModel?.thinkingLevel
        ?? profile.thinking
        ?? profileModel?.thinkingLevel
        ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      assertParentAdmission(dependencies.getSession(parentSessionId), admission);
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: (callModel ?? profileModel)?.model ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        ...subagentToolOptions({ tools: activeTools, allExtensionTools, mcp: mcpEnabled }),
      });
      try { assertParentAdmission(dependencies.getSession(parentSessionId), admission); }
      catch (error) { inner.dispose(); throw error; }
      persistChildSession(sessionManager);
      skillsBinding.setActiveToolsGetter(() => inner.getActiveToolNames());
      const childSession = dependencies.registerSession(inner, {
        ...(skillsBinding.getExactSystemPrompt !== undefined
          ? { exactSystemPrompt: skillsBinding.getExactSystemPrompt }
          : {}),
        chatOnly,
        ...(mcp?.mcpHost ? { mcpHost: mcp.mcpHost } : {}),
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => {
        let settled = false;
        resolveCompletion = (run) => {
          if (settled) return;
          settled = true;
          if (stored.suppressParentNotification) stoppedSubagentResults().add(run);
          resolve(run);
        };
      });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
        dispatchedAt: Date.now(),
      };
      registerSubagentParent(initialRun.sessionId, parentSessionId);
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else if (stored.mcpWait) stored.mcpWait.abort();
        else void inner.abort();
      };
      if (!runInBackground) {
        if (request.signal?.aborted) handleParentAbort();
        else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
      }

      const runToResult = async (): Promise<SubagentRunInfo> => {
        // Reached only when the abort fires while the run is being queued, before `cancelQueued`
        // is set; a run aborted later in the queue ends in `finishQueuedAbort`.
        if (stored.abortRequested) {
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const result = recordResult(sessionManager, {
            ...initialRun,
            status: "aborted",
            completedAt: new Date().toISOString(),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        let turnCount = 0;
        let maxTurnsReached = false;
        let undelivered: string[] = [];
        const previousFinishTurn = inner.agent.finishTurn;
        const previousSteeringMode = inner.agent.steeringMode;
        let unsubscribeTools: (() => void) | undefined;
        if (turnLimit) {
          // Finalized events retain the SDK's terminate hint; tool-result messages do not.
          const terminatingTools = new Set<string>();
          unsubscribeTools = inner.subscribe((event) => {
            if (event.type === "tool_execution_end" && event.result?.terminate === true) {
              terminatingTools.add(event.toolCallId);
            }
          });
          inner.agent.finishTurn = async (turn, signal) => {
            const decision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
            const toolsContinue = turn.toolResults.some((message) => !terminatingTools.has(message.toolCallId));
            terminatingTools.clear();
            turnCount += 1;
            if (signal?.aborted || decision?.action === "end" ||
              turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
            const needsAnotherTurn = toolsContinue || decision?.action === "continue" || inner.agent.hasQueuedMessages();
            if (!needsAnotherTurn || turnCount < turnLimit) return decision;
            if (turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              stored.turnLimitReached = true;
              // AgentSession starts another run for anything still queued, past an `end`
              // decision, so the limit holds only once the queues are empty.
              const { steering, followUp } = inner.clearQueue();
              undelivered = [...undelivered, ...steering, ...followUp];
              return { action: "end" };
            }
            // The awaited SDK boundary delivers the instruction before the wrap-up request.
            // In one-at-a-time mode a steer queued earlier would take the wrap-up turn and
            // leave the instruction for later, so that turn takes everything queued.
            inner.agent.steeringMode = "all";
            await inner.steer(TURN_LIMIT_INSTRUCTION);
            return decision;
          };
        }
        let result: SubagentRunInfo;
        try {
          await prepareChildMcp(childSession, stored);
          if (stored.abortRequested) throw new Error("Subagent is stopping");
          await inner.prompt(delegatedTask, childPromptOptions(inner, stored));
          const text = inner.getLastAssistantText()?.trim();
          const stop = stored.abortRequested ? undefined : lastAssistantStop(sessionManager);
          const aborted = stored.abortRequested || stop?.aborted === true;
          const errorMessage = aborted ? undefined : stop?.error ??
            (maxTurnsReached && turnLimit ? turnLimitError(turnLimit, undelivered) : undefined);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          if (turnLimit) {
            inner.agent.finishTurn = previousFinishTurn;
            inner.agent.steeringMode = previousSteeringMode;
          }
          unsubscribeTools?.();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        result = recordResult(sessionManager, result);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };
      const execute = async (): Promise<SubagentRunInfo> => {
        try {
          return await runToResult();
        } finally {
          if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        }
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        try {
          const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const finalResult = recordResult(sessionManager, cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result);
          stored.run = finalResult;
          request.onUpdate?.(finalResult);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          resolveCompletion(finalResult);
        } finally {
          if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        }
      };
      let queued: ReturnType<SubagentQueue<SubagentRunInfo>["enqueue"]>;
      try {
        queued = getSubagentQueue().enqueue(
          parentSessionId,
          readSubagentSettings().maxConcurrent,
          execute,
          (state) => {
            if (state === "queued") {
              sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
            }
            request.onUpdate?.({ ...stored.run, status: state });
            stored.run = { ...stored.run, status: state };
            dependencies.invalidateSessionList();
          },
          finishQueuedAbort,
        );
      } catch (error) {
        request.signal?.removeEventListener("abort", handleParentAbort);
        if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        throw error;
      }
      stored.cancelQueued = queued.cancel;
      if (stored.abortRequested) queued.cancel();
      void queued.promise.then(resolveCompletion, (error) => {
        if (dropSubagentRun(initialRun.sessionId, stored)) dependencies.invalidateSessionList();
        resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    // Serialize admission only: once queued, the run map prevents another resume while the
    // child works. Never hold this lock for the child's completion (or its parent's queue).
    const admission = beginSubagentAdmission(request.parentContext.sessionManager.getSessionId());
    try { return await serializeByKey(RESUME_ADMISSION_LOCK, request.sessionId, () => admitResume(request, admission)); }
    finally { endSubagentAdmission(admission); }
  }

  async function admitResume(request: ResumeSubagentRequest, admission: SubagentAdmission): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    rememberOwnerAncestry(parentSessionId);
    assertParentAdmission(dependencies.getSession(parentSessionId), admission);
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    assertParentAdmission(parent, admission);
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    // Disk-only inspection precedes reopen, which can import resources and connect services.
    assertParentAdmission(dependencies.getSession(parentSessionId), admission);
    assertContinuation(parent, sessionPath, request.sessionId, parentSessionId);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    // Reopen can await resource loading while the parent closes or changes modes. Keep the
    // pre-reopen check above to prevent unauthorized imports, then revalidate admission against
    // the current owner/parent/policy before touching the run map or queue. Already admitted
    // children retain their saved ceiling; a mode change never mutates them.
    const current = await get(request.sessionId);
    if (!current || current.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    const currentParent = dependencies.getSession(parentSessionId);
    assertParentAdmission(currentParent, admission);
    assertContinuation(currentParent, sessionPath, request.sessionId, parentSessionId);
    if (!wrapper.isAlive() || wrapper.isStopping?.()) throw new Error("Subagent session is no longer available or is stopping");
    if (current.status === "running" || current.status === "queued" || wrapper.isRunning()) throw new Error("Subagent is already running");
    // The run prompts the SDK session directly, past the wrapper's `send()`, so refuse here as
    // `send()` does: an isolated child's worktree is removed when its run ends, and a run in the
    // missing folder would only let the model's tools fail (and `write` recreate it outside git).
    // The error reaches the model, so it also says what to do instead.
    if (!existsSync(wrapper.cwd)) throw new Error(`Directory does not exist: ${wrapper.cwd}. Start a new subagent instead.`);

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      // Resume removes no worktree: this run's result says only whether it is still there.
      worktreeCleanupError: undefined,
      worktreeExists: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => {
      let settled = false;
      resolveCompletion = (run) => {
        if (settled) return;
        settled = true;
        if (stored.suppressParentNotification) stoppedSubagentResults().add(run);
        resolve(run);
      };
    });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false, dispatchedAt: Date.now() };
    registerSubagentParent(request.sessionId, parentSessionId);
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else if (stored.mcpWait) stored.mcpWait.abort();
      else void wrapper!.inner.abort();
    };
    if (!runInBackground) {
      if (request.signal?.aborted) handleParentAbort();
      else request.signal?.addEventListener("abort", handleParentAbort, { once: true });
    }

    const runToResult = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        getSubagentRuns().delete(request.sessionId);
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      let result: SubagentRunInfo;
      try {
        await prepareChildMcp(wrapper, stored);
        if (stored.abortRequested) throw new Error("Subagent is stopping");
        await wrapper!.inner.prompt(request.task, childPromptOptions(wrapper!.inner, stored));
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const stop = stored.abortRequested ? undefined : lastAssistantStop(manager);
        const aborted = stored.abortRequested || stop?.aborted === true;
        const providerError = aborted ? undefined : stop?.error;
        result = {
          ...initialRun,
          status: aborted ? "aborted" : providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(providerError ? { error: providerError } : {}),
        };
      } catch (error) {
        result = {
          ...initialRun,
          status: stored.abortRequested || request.signal?.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested && !request.signal?.aborted ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      result = recordResult(manager, result);
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      return result;
    };
    const execute = async (): Promise<SubagentRunInfo> => {
      try {
        return await runToResult();
      } finally {
        if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      }
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      try {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(request.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(result);
      } finally {
        if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      }
    };
    let queued: ReturnType<SubagentQueue<SubagentRunInfo>["enqueue"]>;
    try {
      queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
        if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
        stored.run = { ...stored.run, status: state };
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
      }, finishQueuedAbort);
    } catch (error) {
      request.signal?.removeEventListener("abort", handleParentAbort);
      if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      throw error;
    }
    stored.cancelQueued = queued.cancel;
    if (stored.abortRequested) queued.cancel();
    void queued.promise.then(resolveCompletion, (error) => {
      if (dropSubagentRun(request.sessionId, stored)) dependencies.invalidateSessionList();
      resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    });
    return { run: stored.run, completion };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return settleOrphanedRun(run);
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    return run && settleOrphanedRun(run);
  }

  function assertContinuation(parent: HostSession, path: string, sessionId: string, parentSessionId: string): void {
    const selection = readSessionToolSelection(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[]);
    const mode = localSubagentMode(selection);
    // Full/profile behavior is unchanged. Only limited parents need disk provenance inspection.
    if (mode !== "plan" && mode !== "build") {
      assertLocalSubagentContinuation(null, selection, []);
      return;
    }
    const entries = SessionManager.open(path).getEntries() as unknown as SessionEntry[];
    const run = readSubagentRun(entries, sessionId, path);
    if (!run || run.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    assertLocalSubagentContinuation(readSubagentSessionResources(entries), selection, getAllSubagentProfiles(parent.cwd));
  }

  async function steer(sessionId: string, message: string, parentContext?: ExtensionContext): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    // Legacy direct callers may omit ctx; infer the owning live parent, never assume full.
    const run = await get(sessionId);
    const parentSessionId = parentContext?.sessionManager.getSessionId() ?? run?.parentSessionId;
    const parent = parentSessionId ? dependencies.getSession(parentSessionId) : undefined;
    if (!parent?.isAlive() || !parentSessionId) throw new Error("Parent session is no longer available");
    if (parent.isStopping?.() || globalThis.__piSubagentStoppingFamily?.has(parentSessionId)) throw new Error("Parent session is stopping");
    if (!run || run.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    const path = wrapper?.sessionFile || run.sessionPath || await dependencies.resolveSessionPath(sessionId);
    if (!path) throw new Error("Subagent session file not found");
    const currentParent = dependencies.getSession(parentSessionId);
    if (!currentParent?.isAlive() || currentParent.isStopping?.() || globalThis.__piSubagentStoppingFamily?.has(parentSessionId)) throw new Error("Parent session is stopping or no longer available");
    assertContinuation(currentParent, path, sessionId, parentSessionId);
    if (wrapper?.isStopping?.()) throw new Error("Subagent is stopping");
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (getSubagentRuns().get(sessionId)?.turnLimitReached) throw new Error("Subagent reached its turn limit and is stopping; resume it to continue");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    if (stoppedSubagentResults().has(run)) return;
    const notificationId = randomUUID();
    const pending: ParentNotification = {
      sessionId: run.sessionId, parentSessionId: run.parentSessionId, completedAt: run.completedAt,
      since: Date.now(), completionRun: run, notificationId,
    };
    const notifications = getParentNotifications();
    const tokens = globalThis.__piSubagentNotificationTokens ??= new Map();
    pending.onDispatched = () => {
      pending.dispatched = true;
      notifications.delete(pending);
      tokens.delete(notificationId);
      pending.unsubscribe?.();
      pending.unsubscribe = undefined;
    };
    notifications.add(pending);
    tokens.set(notificationId, pending);
    try {
      await deliverParentNotification(run, pending);
    } catch (error) {
      pending.onDispatched();
      throw error;
    } finally {
      // sendCustomMessage may return while agent_settled still holds its deferred action.
      // Keep that action's permanent token/guard until the real before_agent_start boundary.
      if (!pending.submitted || pending.dispatched) pending.onDispatched();
    }
  }

  async function deliverParentNotification(run: SubagentRunInfo, pending: ParentNotification): Promise<void> {
    const suppressed = () => pending.cancelled === true || stoppedSubagentResults().has(run)
      || globalThis.__piSubagentStoppingFamily?.has(run.parentSessionId) === true
      || dependencies.getSession(run.parentSessionId)?.isStopping?.() === true;
    pending.isSuppressed = () => suppressed() || takeResultConsumed(run);
    if (suppressed() || takeResultConsumed(run)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (suppressed()) return;
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    if (suppressed()) return;
    await parent.waitUntilReady();
    if (suppressed()) return;
    // The parent may still be inside the `get_subagent_result` call that collects this result,
    // and `deliverAs: "followUp"` would only queue the message until that turn ends anyway.
    // Hold the notification until the parent is idle and re-check the mark, so a result the
    // parent already consumed never triggers a duplicate turn.
    while (parent.isAlive() && parent.isRunning()) {
      if (suppressed() || takeResultConsumed(run)) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, PARENT_IDLE_POLL_MS); });
    }
    if (suppressed() || takeResultConsumed(run)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    // Public-event fallback for wrappers created before the cancellation factory was added
    // (hot reload). The installed factory is earlier and matches the precise custom token.
    if (typeof parent.inner.subscribe === "function") {
      const inner = parent.inner;
      pending.unsubscribe = inner.subscribe((event) => {
        if (event.type !== "agent_start") return;
        if (pending.isSuppressed?.()) void inner.abort().catch(() => undefined);
        pending.onDispatched?.();
      });
    }
    pending.submitted = true;
    const sending = parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: { ...subagentToolDetails(run), notificationId: pending.notificationId },
    }, { deliverAs: "followUp", triggerTurn: true });
    // Historical structural test hosts have no event API: their sendCustomMessage
    // returning means the turn started. The installed SDK's deferred action is
    // covered by the before_agent_start token gate instead.
    if (typeof parent.inner.subscribe !== "function") pending.onDispatched?.();
    await sending;
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    // Still connecting its MCP servers: no run to stop yet, so the wait ends instead.
    if (stored?.mcpWait) {
      stored.abortRequested = true;
      stored.mcpWait.abort();
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, resume, get, steer, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
    abortFamily: (sessionId) => abortSubagentFamily(sessionId, dependencies),
  };
}
