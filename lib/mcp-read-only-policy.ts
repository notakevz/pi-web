import type { InlineExtension, ToolInfo } from "@earendil-works/pi-coding-agent";
import { MCP_EXTENSION_PATH } from "./mcp-command";
import { readSessionToolSelection } from "./session-tool-selection";
import { SDK_BUILTIN_TOOLS } from "./subagents";
import type { SessionEntry } from "./types";
import { localModeGuideline, localToolCallBlockReason, localToolPolicy } from "./local-tool-modes";

// Normal sessions enforce the local plan/build/full policy below. Subagent
// wrappers retain their profile-scoped MCP policy (ADR 0006). An annotation or
// description marker is the trusted extension's word, not a security sandbox.

const WRITE_CAPABLE_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
const MCP_TOOL_PREFIX = "mcp__";

export const READ_ONLY_MCP_POLICY_EXTENSION_NAME = "pi-web-read-only-mcp";

/**
 * Whether a pinned tool selection is read-only: it names tools, and none of
 * them can write or run commands. The Read-only preset is one; so is a subset
 * of it. No pin (pi's configured tools) is not.
 */
export function isReadOnlySelection(tools: readonly string[] | undefined): boolean {
  return tools !== undefined && tools.length > 0 && !tools.some((name) => WRITE_CAPABLE_TOOLS.has(name));
}

/** A tool the MCP extension registered, or one named like an MCP tool by another MCP extension. */
export function isMcpTool(tool: Pick<ToolInfo, "name" | "sourceInfo">): boolean {
  return tool.sourceInfo?.path === MCP_EXTENSION_PATH || tool.name.startsWith(MCP_TOOL_PREFIX);
}

export function readOnlyMcpBlockReason(toolName: string): string {
  return `This session uses a read-only tool selection, and the MCP server does not mark "${toolName}" as read-only (readOnlyHint), so the call was blocked. Switch the session to a preset that allows changes to use it.`;
}

export const SUBAGENT_MCP_POLICY_EXTENSION_NAME = "pi-web-subagent-mcp-policy";

export function subagentReadOnlyMcpBlockReason(toolName: string): string {
  return `This subagent's profile gives it read-only tools, and the MCP server does not mark "${toolName}" as read-only (readOnlyHint), so the call was blocked.`;
}

export function unselectedMcpToolBlockReason(toolName: string): string {
  return `"${toolName}" comes from an extension this subagent's profile did not select, so the call was blocked.`;
}

/**
 * The MCP policy of a subagent with `mcp: on`, whose tools are its profile's, not a pin. While
 * its built-in tools are read-only (Explore, Plan), it blocks MCP tools without
 * `readOnlyHint: true` as the Read-only policy does; a profile of extension tools alone is not
 * read-only. An allowlist admits MCP tools by name alone (`mcp__*`, the SDK's only test), so
 * it would also admit those of an extension the profile's `ext:` selectors left out: only pi's
 * built-in MCP extension's tools and the ones the profile named may run. `scope` is read at
 * every call, so spawn can hand it over once the extension tools are resolved.
 */
export function createSubagentMcpPolicyExtension(
  scope: () => { tools: readonly string[]; allExtensionTools?: boolean },
): InlineExtension {
  return {
    name: SUBAGENT_MCP_POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Nested calls (a codemode script's) pass through tool_call as well.
      pi.on("tool_call", (event) => {
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!tool || !isMcpTool(tool)) return undefined;
        const { tools, allExtensionTools } = scope();
        if (!allExtensionTools && tool.sourceInfo?.path !== MCP_EXTENSION_PATH && !tools.includes(tool.name)) {
          return { block: true, reason: unselectedMcpToolBlockReason(event.toolName) };
        }
        if (tool.annotations?.readOnlyHint === true) return undefined;
        if (!isReadOnlySelection(tools.filter((name) => SDK_BUILTIN_TOOLS.includes(name)))) return undefined;
        return { block: true, reason: subagentReadOnlyMcpBlockReason(event.toolName) };
      });
    },
  };
}

export function createReadOnlyMcpPolicyExtension(
  defaultTools: () => readonly string[] | undefined = () => undefined,
): InlineExtension {
  return {
    name: READ_ONLY_MCP_POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event, ctx) => {
        const policy = localToolPolicy(
          readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]),
          pi.getAllTools(), pi.getActiveTools(), defaultTools(),
        );
        pi.setActiveTools(policy.active);
        // An earlier handler may have edited selectedTools explicitly; pi gives
        // that edit precedence over setActiveTools. Reassert both upstream paths.
        event.systemPromptOptions.selectedTools = pi.getActiveTools();
        const guideline = localModeGuideline(policy.mode);
        if (guideline) event.systemPromptOptions.promptGuidelines.push(guideline);
      });
      // Every call, not merely MCP: deferred/codemode tools remain callable
      // when undeclared. Custom-message-triggered runs also pass this guard.
      pi.on("tool_call", (event, ctx) => {
        const tools = pi.getAllTools();
        const selection = readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]);
        const policy = localToolPolicy(selection, tools, pi.getActiveTools(), defaultTools());
        const reason = localToolCallBlockReason(policy, tools, event.toolName, event.input);
        if (reason) return { block: true, reason };
        const tool = tools.find((candidate) => candidate.name === event.toolName);
        if (tool && isMcpTool(tool) && tool.annotations?.readOnlyHint !== true && isReadOnlySelection(selection)) {
          return { block: true, reason: readOnlyMcpBlockReason(event.toolName) };
        }
        return undefined;
      });
    },
  };
}
