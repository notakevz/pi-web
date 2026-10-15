import { THINKING_CONTROL_LEVELS, type ThinkingControlLevel } from "./thinking-controls";

/** Match pi-ai's clamp: the next supported level up, otherwise the nearest below. */
export function clampSupportedThinkingLevel(
  level: ThinkingControlLevel,
  supported?: readonly string[],
): ThinkingControlLevel {
  if (!supported?.length || supported.includes(level)) return level;
  const index = THINKING_CONTROL_LEVELS.indexOf(level);
  return THINKING_CONTROL_LEVELS.slice(index).find((candidate) => supported.includes(candidate))
    ?? [...THINKING_CONTROL_LEVELS.slice(0, index)].reverse().find((candidate) => supported.includes(candidate))
    ?? "off";
}

/** Pins outrank exact provider/model defaults, then the ordinary global fallback. */
export function modelThinkingDefault(
  model: { provider: string; modelId: string },
  pins: Record<string, string>,
  defaults: Record<string, string>,
  globalDefault: string | null,
  supported?: readonly string[],
): ThinkingControlLevel | null {
  const key = `${model.provider}/${model.modelId}`;
  for (const value of [pins[key], defaults[key], globalDefault]) {
    if (THINKING_CONTROL_LEVELS.includes(value as ThinkingControlLevel)) {
      return clampSupportedThinkingLevel(value as ThinkingControlLevel, supported);
    }
  }
  return null;
}
