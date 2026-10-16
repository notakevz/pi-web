import { resolveShellTools } from "./powershell-settings";

// Keep the upstream wire lists and pi-web:tool-selection entries. These are
// local runtime rules, not another persisted preset/configuration format.
export const LOCAL_BUILD_TOOLS = ["read", "bash", "edit", "write"];
const CODING_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const SUBAGENT_MARKER = "In plan/build, children cannot load extensions or MCP";
const WEBFETCH_MARKER = "Read-only webfetch:";

export interface LocalModeTool {
  name: string;
  description: string;
  exposure?: string;
  annotations?: { readOnlyHint?: boolean };
}

export type LocalToolMode = "none" | "plan" | "build" | "full" | "restricted";

/** Upstream coding-only replacement for profile-scoped wrappers and legacy subsets. */
export function carryCodingToolSelection(
  requested: readonly string[], tools: readonly LocalModeTool[],
  carry: readonly string[], defaultTools?: readonly string[],
): string[] {
  if (requested.length === 0) return [];
  const builtins = resolveShellTools(requested.filter((name) => CODING_TOOLS.has(name)), defaultTools);
  const extras = carry.filter((name) => !CODING_TOOLS.has(name)
    && tools.some((tool) => tool.name === name && tool.exposure !== "hidden"));
  return [...new Set([...builtins, ...extras])];
}

/** The same resolved selection feeds both activation and the execution guard. */
export function localToolPolicy(
  requested: readonly string[] | undefined,
  tools: readonly LocalModeTool[],
  carry: readonly string[] = [],
  defaultTools?: readonly string[],
): { mode: LocalToolMode; builtins: string[]; active: string[] } {
  const selection = requested ?? LOCAL_BUILD_TOOLS;
  const builtins = resolveShellTools(selection.filter((name) => CODING_TOOLS.has(name)), defaultTools);
  const key = builtins.map((name) => name === "powershell" ? "bash" : name).sort().join(",");
  const mode: LocalToolMode = selection.length === 0 ? "none"
    : key === "find,grep,ls,read" ? "plan"
    : key === "bash,edit,read,write" ? "build"
    : key === "bash,edit,find,grep,ls,read,write" ? "full" : "restricted";
  const visible = tools.filter((tool) => tool.exposure !== "hidden");
  if (mode === "none") return { mode, builtins, active: [] };
  if (mode === "full") return { mode, builtins, active: visible.map((tool) => tool.name) };
  const extras = mode === "plan" || mode === "build"
    ? visible.filter(isLimitedModeExtra).map((tool) => tool.name)
    // Preserve the upstream carry rule for legacy, non-preset selections.
    : carryCodingToolSelection(selection, tools, carry, defaultTools).filter((name) => !CODING_TOOLS.has(name));
  return { mode, builtins, active: [...new Set([...builtins, ...extras])] };
}

function isLimitedModeExtra(tool: LocalModeTool): boolean {
  return tool.name === "subagent" && tool.description.includes(SUBAGENT_MARKER)
    || tool.name === "webfetch" && tool.annotations?.readOnlyHint === true && tool.description.includes(WEBFETCH_MARKER);
}

export function localModeGuideline(mode: LocalToolMode): string | undefined {
  if (mode !== "plan" && mode !== "build") return undefined;
  return `Current tool mode: ${mode === "plan" ? "plan; subagent roles: scout / planner (read-only)." : "build; subagent roles: scout / planner (read-only), worker / reviewer."} Use only user-level roles; switch modes explicitly for other roles.`;
}

/** Return a refusal for every disallowed call, including nested/deferred calls. */
export function localToolCallBlockReason(
  policy: ReturnType<typeof localToolPolicy>,
  tools: readonly LocalModeTool[],
  toolName: string,
  input: unknown,
): string | undefined {
  const tool = tools.find((candidate) => candidate.name === toolName && candidate.exposure !== "hidden");
  if (!tool) return `Tool "${toolName}" is unavailable in this session.`;
  if (policy.mode === "full") return undefined;
  const limited = policy.mode === "plan" || policy.mode === "build";
  const permitted = policy.builtins.includes(toolName) || limited && policy.active.includes(toolName);
  if (policy.mode === "none" || !permitted) {
    return `Tool "${toolName}" is disabled in this session's ${policy.mode} mode.`;
  }
  if (!limited || toolName !== "subagent") return undefined;
  const roles = policy.mode === "plan" ? ["scout", "planner"] : ["scout", "planner", "worker", "reviewer"];
  const params = input as { agentScope?: unknown; agent?: unknown; tasks?: unknown; chain?: unknown } | null;
  if (!params || typeof params !== "object" || Array.isArray(params)) return "Invalid plan/build subagent request.";
  if (params.agentScope !== undefined && params.agentScope !== "user") return "plan/build subagents must use user-level roles.";
  const requested: unknown[] = params.agent === undefined ? [] : [params.agent];
  for (const batch of [params.tasks, params.chain]) {
    if (batch === undefined) continue;
    if (!Array.isArray(batch)) return "Invalid plan/build subagent request.";
    for (const task of batch) requested.push(task?.agent);
  }
  // Reject the whole request before any child starts, even if only one task is
  // cross-group. The tool's own schema validates the rest of the request.
  if (requested.some((role) => !roles.includes(role as string))) {
    return `This mode only permits subagent roles: ${roles.join(" / ")}`;
  }
  return undefined;
}
