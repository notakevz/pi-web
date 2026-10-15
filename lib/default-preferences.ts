import { join } from "path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { displaySettingsPath } from "./enabled-models-runtime";
import { serializeByKey } from "./key-serializer";

const DEFAULT_WRITES = Symbol.for("pi-web.default-preferences-writes");

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

/** What the model and reasoning selectors' "save as default" action writes. */
export interface DefaultPreferencesEdit {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** A startup override for this exact model, not a new global default model. */
  modelThinkingLevel?: { provider: string; modelId: string; level: ThinkingLevel };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelReference(value: Record<string, unknown>): value is Record<string, unknown> & { provider: string; modelId: string } {
  return typeof value.provider === "string" && value.provider.trim().length > 0
    && typeof value.modelId === "string" && value.modelId.trim().length > 0;
}

/** Legacy model/global effort edits remain valid; a per-model edit is a separate operation. */
export function parseDefaultPreferencesEdit(body: unknown): DefaultPreferencesEdit | null {
  if (!isRecord(body)) return null;
  const allowed = new Set(["cwd", "provider", "modelId", "thinkingLevel", "modelThinkingLevel"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (body.cwd !== undefined && (typeof body.cwd !== "string" || !body.cwd.trim())) return null;
  if (body.modelThinkingLevel !== undefined) {
    if (body.provider !== undefined || body.modelId !== undefined || body.thinkingLevel !== undefined) return null;
    const target = body.modelThinkingLevel;
    if (!isRecord(target) || !isModelReference(target) || !isThinkingLevel(target.level)) return null;
    if (Object.keys(target).some((key) => !["provider", "modelId", "level"].includes(key))) return null;
    return { modelThinkingLevel: { provider: target.provider, modelId: target.modelId, level: target.level } };
  }
  const edit: DefaultPreferencesEdit = {};
  if (body.provider !== undefined || body.modelId !== undefined) {
    if (!isModelReference(body)) return null;
    edit.model = { provider: body.provider, modelId: body.modelId };
  }
  if (body.thinkingLevel !== undefined) {
    if (!isThinkingLevel(body.thinkingLevel)) return null;
    edit.thinkingLevel = body.thinkingLevel;
  }
  return edit.model || edit.thinkingLevel ? edit : null;
}

/**
 * Project settings keys that would hide this edit.
 *
 * `SettingsManager` only ever writes the global file, and a project
 * `.pi/settings.json` value wins over it, so writing a default the project
 * overrides would report success while new chats kept starting with the
 * project's choice. The route refuses instead and names the file.
 */
export function shadowingProjectKeys(
  settingsManager: SettingsManager,
  edit: DefaultPreferencesEdit,
): string[] {
  const project = settingsManager.getProjectSettings();
  const keys: string[] = [];
  if (edit.model) {
    if (project.defaultProvider !== undefined) keys.push("defaultProvider");
    if (project.defaultModel !== undefined) keys.push("defaultModel");
  }
  if (edit.thinkingLevel && project.defaultThinkingLevel !== undefined) keys.push("defaultThinkingLevel");
  if (edit.modelThinkingLevel) {
    const { provider, modelId } = edit.modelThinkingLevel;
    const key = `${provider}/${modelId}`;
    // Nested objects merge per key. A matching null also masks the global
    // entry (startup then falls back), so test presence, not truthiness.
    if (project.modelThinkingLevels && Object.prototype.hasOwnProperty.call(project.modelThinkingLevels, key)) {
      keys.push(`modelThinkingLevels.${key}`);
    }
  }
  return keys;
}

export function projectSettingsPath(cwd: string): string {
  return displaySettingsPath(join(cwd, ".pi", "settings.json"));
}

/**
 * Persist the global defaults new sessions start with, like the TUI's Ctrl+S
 * in `/model` and `/thinking`.
 *
 * `SettingsManager` skips the write when it could not load the settings file
 * and collects storage failures instead of throwing, so the queue is drained
 * here: a default that did not reach disk must not report success.
 */
export async function writeDefaultPreferences(
  settingsManager: SettingsManager,
  edit: DefaultPreferencesEdit,
  globalSettingsPath?: string,
): Promise<void> {
  const loadErrors = settingsManager.drainErrors();
  if (loadErrors.length > 0) throw loadErrors[0].error;
  if (edit.modelThinkingLevel && globalSettingsPath) {
    // The native setter marks the whole map, not just this model key. Reload
    // inside a shared queue so concurrent web saves do not use stale maps.
    // Other processes (e.g. the TUI) can still race this read/write boundary.
    await serializeByKey(DEFAULT_WRITES, globalSettingsPath, async () => {
      await settingsManager.reload();
      await writeDefaultPreferences(settingsManager, edit);
    });
    return;
  }
  if (edit.modelThinkingLevel) {
    const { provider, modelId, level } = edit.modelThinkingLevel;
    settingsManager.setModelThinkingLevel(provider, modelId, level);
  }
  if (edit.model) settingsManager.setDefaultModelAndProvider(edit.model.provider, edit.model.modelId);
  if (edit.thinkingLevel) settingsManager.setDefaultThinkingLevel(edit.thinkingLevel);
  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) throw errors[0].error;
}
