// UI capability detection is transport-driven, never inferred from a model name.
export function hasThinkingToggle(model: { reasoning?: boolean; compat?: unknown }): boolean {
  if (!model.reasoning || !model.compat || typeof model.compat !== "object") return false;
  const compat = model.compat as Record<string, unknown>;
  if (compat.thinkingFormat === "qwen" || compat.thinkingFormat === "qwen-chat-template") return true;
  if (compat.thinkingFormat !== "chat-template") return false;
  const kwargs = compat.chatTemplateKwargs as Record<string, unknown> | undefined;
  const enabled = kwargs?.enable_thinking;
  return typeof enabled === "object" && enabled !== null
    && (enabled as Record<string, unknown>).$var === "thinking.enabled"
    && !(enabled as Record<string, unknown>).omitWhenOff;
}

export const THINKING_CONTROL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingControlLevel = typeof THINKING_CONTROL_LEVELS[number];

export function thinkingControlState(
  supported: readonly string[] | null | undefined,
  current: string | null,
  toggleSupported: boolean,
) {
  const levels = THINKING_CONTROL_LEVELS.filter((level) => !supported || supported.includes(level));
  const nonOff = levels.filter((level) => level !== "off");
  // Never offer off when the SDK would clamp it back to an enabled level.
  const toggle = toggleSupported && !!supported?.includes("off") && nonOff.length > 0;
  return {
    mode: nonOff.length === 0 ? "none" : toggle
      ? nonOff.length === 1 ? "toggle" : "toggle-levels"
      : "levels",
    enabled: current !== "off",
    levels,
    // Binary transports show on then off; effort menus keep off first.
    // Every entry is an actual SDK-supported level, not a remembered effort.
    menuLevels: toggle && nonOff.length === 1 ? [nonOff[0], "off" as const] : levels,
  } as const;
}
