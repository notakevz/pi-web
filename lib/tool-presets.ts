export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  /** Active, but left out of requests: the model calls it only from codemode scripts. */
  declarationHidden?: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
}

/** Presets that pin an explicit tool list onto the session. */
export const CONCRETE_TOOL_PRESET_VALUES = ["none", "read-only", "default", "full"] as const;
export type ConcreteToolPreset = typeof CONCRETE_TOOL_PRESET_VALUES[number];

/**
 * Legacy "configured" is not a tool list: it sends no override. Keep accepting it
 * for saved browser preferences and API compatibility; ordinary unpinned sessions
 * now use build, not settings.json defaultTools.
 */
export const CONFIGURED_TOOL_PRESET = "configured";
export const TOOL_PRESET_VALUES = ["configured", "none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

/** UI names are independent of the persisted/wire preset IDs. */
export const TOOL_MODE_PRESETS = { plan: "read-only", build: "default", full: "full" } as const;
export type ToolMode = keyof typeof TOOL_MODE_PRESETS;
/** Fresh composers and unpinned historical sessions default to build. */
export const DEFAULT_TOOL_PRESET: ConcreteToolPreset = TOOL_MODE_PRESETS.build;
export const NEW_SESSION_TOOL_PRESET: ConcreteToolPreset = TOOL_MODE_PRESETS.build;

/** Legacy configured/none selections keep their behavior, but show build as before. */
export function getToolModeLabel(preset: ToolPreset | undefined): ToolMode {
  if (preset === TOOL_MODE_PRESETS.plan) return "plan";
  if (preset === TOOL_MODE_PRESETS.full) return "full";
  return "build";
}

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function isConcreteToolPreset(value: unknown): value is ConcreteToolPreset {
  return typeof value === "string" && (CONCRETE_TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

export function getPresetFromTools(tools: ToolEntry[]): ConcreteToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

export function getPresetFromToolNames(toolNames: readonly string[]): ConcreteToolPreset {
  if (toolNames.length === 0) return "none";

  // Full activates both registered shells. Canonicalize before deduplicating
  // so its live loadout cannot be mistaken for build after get_tools.
  const active = [...new Set(toolNames
    .map((name) => name === "powershell" ? "bash" : name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name)))]
    .sort()
    .join(",");

  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

/** Undefined is reserved for the legacy configured sentinel; build is always explicit. */
export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {
  if (preset === CONFIGURED_TOOL_PRESET) return undefined;
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}
