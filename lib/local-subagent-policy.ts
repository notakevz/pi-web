import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type InlineExtension, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { localToolPolicy, type LocalToolMode } from "./local-tool-modes";
import type { SubagentProfile, SubagentSessionResources } from "./subagents";

const BUILTINS = new Set(["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"]);
export const LOCAL_SUBAGENT_READ_TOOLS = ["read", "grep", "find", "ls"] as const;
const READ_ROLES = ["scout", "planner"];
const BUILD_ROLES = [...READ_ROLES, "worker", "reviewer"];
const PRECEDENCE = { builtin: 0, global: 1, workspace: 2, project: 3 };

/** Use the parent's persisted selection, not its current active extension tools. No pin means build. */
export function localSubagentMode(selection: readonly string[] | undefined): LocalToolMode {
  return localToolPolicy(selection, []).mode;
}

/**
 * Takes ALL raw profile sources, before effective overrides. Limited modes select only global
 * roles, so a same-name project/workspace/builtin never shadows the trusted user profile.
 * Full (and legacy subsets) retain upstream effective scope precedence, including disabled overrides.
 */
export function filterLocalSubagentProfiles(
  profiles: readonly SubagentProfile[], selection: readonly string[] | undefined,
): SubagentProfile[] {
  const mode = localSubagentMode(selection);
  if (mode === "none") return [];
  const limited = mode === "plan" || mode === "build";
  const roles = mode === "plan" ? READ_ROLES : BUILD_ROLES;
  const effective = new Map<string, SubagentProfile>();
  for (const profile of profiles) {
    const name = profile.name.toLowerCase();
    if (limited && (profile.scope !== "global" || !roles.includes(name))) continue;
    const previous = effective.get(name);
    if (!previous || PRECEDENCE[profile.scope] >= PRECEDENCE[previous.scope]) effective.set(name, profile);
  }
  const selected = [...effective.values()].filter((profile) => profile.enabled);
  return limited ? selected : selected.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Persisted provenance AND immutable resource ceiling; never infer a limited child from its name. */
export interface LocalSubagentPolicy {
  version: 1;
  mode: "plan" | "build";
  scope: "global";
  role: string;
  sourcePath: string;
  builtins: string[];
  webfetch: boolean;
}

/** Only this explicit user-owned extension may be imported. No discovery or project paths. */
export function localSubagentWebfetchPath(): string {
  return join(getAgentDir(), "extensions", "webfetch.ts");
}

function hasLocalWebfetch(): boolean {
  try { return statSync(localSubagentWebfetchPath()).isFile(); } catch { return false; }
}

/** Refuse missing/nonregular explicit resources before the SDK can expand a directory. */
export function localSubagentExtensionPaths(policy: LocalSubagentPolicy): string[] {
  if (!policy.webfetch) return [];
  if (!hasLocalWebfetch()) throw new Error("Cannot restore local subagent policy: trusted webfetch.ts is not a regular file");
  return [localSubagentWebfetchPath()];
}

/** Shared by admission and model-facing descriptions; never advertise raw write-capable scout tools. */
export function localSubagentBuiltins(profile: SubagentProfile): string[] {
  return READ_ROLES.includes(profile.name.toLowerCase()) ? [...LOCAL_SUBAGENT_READ_TOOLS]
    : [...new Set(profile.tools.filter((name) => BUILTINS.has(name)))];
}

export function createLocalSubagentPolicy(profile: SubagentProfile, mode: "plan" | "build"): LocalSubagentPolicy {
  const role = profile.name.toLowerCase();
  if (profile.scope !== "global" || !(mode === "plan" ? READ_ROLES : BUILD_ROLES).includes(role) || !profile.filePath) {
    throw new Error("plan/build subagents require an allowed global role profile");
  }
  return {
    version: 1, mode, scope: "global", role, sourcePath: resolve(profile.filePath),
    builtins: localSubagentBuiltins(profile),
    webfetch: hasLocalWebfetch(),
  };
}

/** Unknown versions, extra powers, and inconsistent read-only roles fail closed on reopen. */
export function parseLocalSubagentPolicy(value: unknown): LocalSubagentPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.version !== 1 || (p.mode !== "plan" && p.mode !== "build") || p.scope !== "global"
    || typeof p.role !== "string" || !(p.mode === "plan" ? READ_ROLES : BUILD_ROLES).includes(p.role)
    || typeof p.sourcePath !== "string" || !p.sourcePath.endsWith(".md")
    || resolve(p.sourcePath) !== p.sourcePath || dirname(p.sourcePath) !== resolve(getAgentDir(), "agents")
    || typeof p.webfetch !== "boolean"
    || !Array.isArray(p.builtins) || !p.builtins.every((name) => typeof name === "string" && BUILTINS.has(name))
    || new Set(p.builtins).size !== p.builtins.length) return null;
  const builtins = p.builtins as string[];
  if (READ_ROLES.includes(p.role) && (builtins.length !== 4 || !LOCAL_SUBAGENT_READ_TOOLS.every((name) => builtins.includes(name)))) return null;
  return { version: 1, mode: p.mode, scope: "global", role: p.role, sourcePath: p.sourcePath, builtins: [...p.builtins] as string[], webfetch: p.webfetch };
}

/** Restricted snapshots cannot carry any resource option from the unrestricted profile path. */
export function localSubagentResourcesMatch(resources: SubagentSessionResources, policy: LocalSubagentPolicy): boolean {
  const tools = [...policy.builtins, ...(policy.webfetch ? ["webfetch"] : [])];
  return !resources.loadExtensions && !resources.loadSkills && !resources.codemode && !resources.mcp
    && !resources.allExtensionTools && resources.skills === undefined && resources.extensions === undefined
    && resources.tools.length === tools.length && new Set(resources.tools).size === tools.length
    && resources.tools.every((name) => tools.includes(name));
}

/** Checked before reopening a child: ownership is checked by the caller independently of mode. */
export function assertLocalSubagentContinuation(
  resources: SubagentSessionResources | null, selection: readonly string[] | undefined,
  profiles: readonly SubagentProfile[],
): void {
  const mode = localSubagentMode(selection);
  if (mode !== "plan" && mode !== "build") {
    if (mode === "none") throw new Error("Subagents are disabled in Chat only mode");
    return; // Full never widens an existing restricted child's saved resources.
  }
  const policy = resources?.localPolicy;
  const profile = policy && filterLocalSubagentProfiles(profiles, selection).find((item) => item.name.toLowerCase() === policy.role);
  if (!resources || !policy || !profile || !profile.filePath || resolve(profile.filePath) !== policy.sourcePath
    || !localSubagentResourcesMatch(resources, policy)) throw new Error("Subagent is not an admitted plan/build global role; start a new subagent instead");
  const ceiling = createLocalSubagentPolicy(profile, mode);
  if (policy.builtins.some((name) => !ceiling.builtins.map((item) => item === "powershell" ? "bash" : item).includes(name === "powershell" ? "bash" : name)) || policy.webfetch && !ceiling.webfetch) {
    throw new Error("Subagent exceeds this parent's current resource ceiling; start a new subagent instead");
  }
}

function trustedWebfetch(tool: ToolInfo): boolean {
  return tool.name === "webfetch" && tool.exposure !== "hidden" && tool.annotations?.readOnlyHint === true
    && tool.description.includes("Read-only webfetch:") && tool.sourceInfo?.path === localSubagentWebfetchPath();
}

/** Every tool_call (nested ones too) is bounded by a copied, immutable spawn-time ceiling. */
export function createLocalSubagentPolicyExtension(policy: LocalSubagentPolicy): InlineExtension {
  const builtins = new Set(policy.builtins);
  const webfetch = policy.webfetch;
  return {
    name: "pi-web-local-subagent-policy", hidden: true,
    factory: (pi) => {
      const allowed = (tool: ToolInfo) => (
        // The only imported extension must not replace an admitted builtin by name.
        tool.exposure !== "hidden" && builtins.has(tool.name) && tool.sourceInfo?.path === `builtin:${tool.name}`
      ) || (webfetch && trustedWebfetch(tool));
      const restore = () => pi.setActiveTools(pi.getAllTools().filter(allowed).map((tool) => tool.name));
      pi.on("session_start", restore);
      pi.on("before_agent_start", (event) => {
        restore();
        event.systemPromptOptions.selectedTools = pi.getActiveTools();
      });
      pi.on("tool_call", (event) => {
        const tool = pi.getAllTools().find((item) => item.name === event.toolName);
        if (!tool || !allowed(tool)) return { block: true, reason: `Tool "${event.toolName}" exceeds this subagent's immutable local resource ceiling.` };
        return undefined;
      });
    },
  };
}
