import { DEFAULT_TOOL_PRESET, isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "pi-tool-preset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Legacy browser preference compatibility, no longer used by useAgentSession.
 * Fresh composers always start in NEW_SESSION_TOOL_PRESET (build); changing the
 * mode is session-scoped. Kept so older explicit values can still round-trip.
 */
export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return DEFAULT_TOOL_PRESET;
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : DEFAULT_TOOL_PRESET;
  } catch {
    return DEFAULT_TOOL_PRESET;
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}
