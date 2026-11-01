import { resolveShellTools } from "./powershell-settings";

// Keep the upstream wire lists and pi-web:tool-selection entries. These are
// local runtime rules, not another persisted preset/configuration format.
export const LOCAL_BUILD_TOOLS = ["read", "bash", "edit", "write"];
const CODING_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const SUBAGENT_MARKER = "In plan/build, children cannot load extensions or MCP";
const WEBFETCH_MARKER = "Read-only webfetch:";
export const HOST_SUBAGENT_EXTENSION_PATH = "<inline:pi-web-subagents>";
const HOST_SUBAGENT_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

export interface LocalModeTool {
  name: string;
  description: string;
  exposure?: string;
  annotations?: { readOnlyHint?: boolean };
  sourceInfo?: unknown;
}

/** SDK getAllTools() supplies the registering extension's path, not its tool name. */
export function isHostSubagentTool(tool: LocalModeTool): boolean {
  const source = tool.sourceInfo;
  return HOST_SUBAGENT_TOOLS.has(tool.name) && typeof source === "object" && source !== null
    && "path" in source && source.path === HOST_SUBAGENT_EXTENSION_PATH;
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

/** Keep prompt order only after resolving the allowed set, never as a policy bypass. */
export function preserveAllowedToolOrder(allowed: readonly string[], previous: readonly string[]): string[] {
  const names = new Set(allowed);
  return previous.length === names.size && new Set(previous).size === names.size
    && previous.every((name) => names.has(name)) ? [...previous] : [...allowed];
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
  const hostPresent = tools.some((tool) => tool.exposure !== "hidden" && isHostSubagentTool(tool));
  // Keep legacy factories registered (and terminal settings untouched), but the
  // Web host supersedes the external dispatcher in every mode, including full.
  const visible = tools.filter((tool) => tool.exposure !== "hidden" && !(hostPresent && tool.name === "subagent"));
  if (mode === "none") return { mode, builtins, active: [] };
  if (mode === "full") return { mode, builtins, active: preserveAllowedToolOrder(visible.map((tool) => tool.name), carry) };
  const extras = mode === "plan" || mode === "build"
    ? visible.filter((tool) => isLimitedModeExtra(tool, hostPresent)).map((tool) => tool.name)
    // Preserve the upstream carry rule for legacy, non-preset selections.
    : carryCodingToolSelection(selection, visible, carry, defaultTools).filter((name) => !CODING_TOOLS.has(name));
  return { mode, builtins, active: preserveAllowedToolOrder([...new Set([...builtins, ...extras])], carry) };
}

function isLimitedModeExtra(tool: LocalModeTool, hostPresent: boolean): boolean {
  return hostPresent && isHostSubagentTool(tool)
    || !hostPresent && tool.name === "subagent" && tool.description.includes(SUBAGENT_MARKER)
    || tool.name === "webfetch" && tool.annotations?.readOnlyHint === true && tool.description.includes(WEBFETCH_MARKER);
}

/** Stable parent instructions, not just a description of permitted child roles. */
export function localParentModeGuidance(mode: LocalToolMode): string | undefined {
  const authority = "The current mode and tool declarations govern this run, not tools, permissions or mode instructions in earlier conversation history. Use only currently available tools; do not probe for missing tools or try to enable tools or change modes yourself. Chat requests, including steering messages, do not change permissions; the user must select a different mode in the tool selector.";
  switch (mode) {
    case "plan":
      return `Current tool mode: plan; subagent roles: scout / planner (read-only). You, the parent assistant, may investigate, analyze and propose plans only. Do not edit or write files, run shell commands, implement changes, or delegate implementation. Delegate only read-only investigation/planning to admitted user-level scout/planner roles. If asked to implement, explain that the user must select build mode first. ${authority}`;
    case "build":
      return `Current tool mode: build; subagent roles: scout / planner (read-only), worker / reviewer. You, the parent assistant, may implement requested changes using the currently available tools, within their permissions and each subagent's role/resource ceiling. Delegate only to admitted user-level roles. Earlier plan-only behavior no longer applies. ${authority}`;
    case "full":
      return `Current tool mode: full. You, the parent assistant, may implement requested changes with the currently selected permissions and available tools, respecting each subagent's profile/resource ceiling. Earlier plan-only behavior no longer applies. Full does not grant administrator privileges or guarantee an operating-system sandbox. ${authority}`;
    default:
      return undefined;
  }
}

/** Compatibility view of the parent guidance: full has no legacy guideline. */
export function localModeGuideline(mode: LocalToolMode): string | undefined {
  return mode === "full" ? undefined : localParentModeGuidance(mode);
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
  if (toolName === "subagent" && tools.some((candidate) => candidate.exposure !== "hidden" && isHostSubagentTool(candidate))) {
    return "The external subagent tool is disabled while Pi Web's built-in subagents are enabled. Use Agent instead.";
  }
  if (policy.mode === "full") return undefined;
  const limited = policy.mode === "plan" || policy.mode === "build";
  const permitted = policy.builtins.includes(toolName) || limited && policy.active.includes(toolName);
  if (policy.mode === "none" || !permitted) {
    return `Tool "${toolName}" is disabled in this session's ${policy.mode} mode.`;
  }
  if (!limited) return undefined;
  const roles = policy.mode === "plan" ? ["scout", "planner"] : ["scout", "planner", "worker", "reviewer"];
  if (isHostSubagentTool(tool) && toolName === "Agent") {
    const params = input as { subagent_type?: unknown; resume?: unknown } | null;
    if (!params || typeof params !== "object" || Array.isArray(params)) return "Invalid plan/build subagent request.";
    if (!params.resume && params.subagent_type !== undefined
      && (typeof params.subagent_type !== "string" || !roles.includes(params.subagent_type.trim().toLowerCase()))) {
      return `This mode only permits subagent roles: ${roles.join(" / ")}`;
    }
    return undefined; // The host validates effective profile/source and resume at dispatch.
  }
  if (toolName !== "subagent") return undefined;
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
