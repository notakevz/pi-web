import { stat } from "fs/promises";
import { join, resolve } from "path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  parseDefaultPreferencesEdit,
  projectSettingsPath,
  shadowingProjectKeys,
  writeDefaultPreferences,
} from "@/lib/default-preferences";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolveVisibleModels } from "@/lib/model-scope";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { invalidateModelsCache } from "@/lib/models-cache";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

/**
 * Save the model and/or reasoning level new sessions start with.
 *
 * Picking a model for one chat is session-scoped, as in the TUI; this is the
 * explicit "save as default" behind the selectors' star. The cwd decides which
 * project settings could shadow the global value and which models are in scope,
 * so it goes through the same allow-list as `/api/models`.
 */
export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const edit = parseDefaultPreferencesEdit(body);
  if (!edit) {
    return Response.json({ error: "Expected provider and modelId, a valid thinkingLevel, or a separate modelThinkingLevel { provider, modelId, level } edit" }, { status: 400 });
  }

  const requestedCwd = (body as { cwd?: string }).cwd;
  const cwd = resolve(requestedCwd || process.cwd());
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const agentDir = getAgentDir();
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const { settingsManager } = services;

    const shadowed = shadowingProjectKeys(settingsManager, edit);
    if (shadowed.length > 0) {
      const settingsPath = projectSettingsPath(cwd);
      return Response.json({
        error: `${settingsPath} sets ${shadowed.join(", ")} for this project, so a global default would not apply here.`,
        reason: "project-scope",
        settingsPath,
        keys: shadowed,
      }, { status: 409 });
    }

    const target = edit.model ?? edit.modelThinkingLevel;
    if (target) {
      // Only a model the selector can offer is a default that actually takes
      // effect: startup falls back to the first scoped model otherwise.
      const scope = await resolveVisibleModels(withDeferredProviderModels(services.modelRuntime), settingsManager.getEnabledModels());
      const { provider, modelId } = target;
      const model = scope.visible.find((model) => model.provider === provider && model.id === modelId);
      if (!model) {
        return Response.json({ error: `Model not available: ${provider}/${modelId}` }, { status: 404 });
      }
      if (edit.modelThinkingLevel) {
        const { level } = edit.modelThinkingLevel;
        if (!getSupportedThinkingLevels(model).includes(level)) {
          return Response.json({ error: `Thinking level not supported for ${provider}/${modelId}: ${level}` }, { status: 400 });
        }
        const pinned = scope.thinkingLevelPins[`${provider}/${modelId}`];
        if (pinned !== undefined && pinned !== level) {
          return Response.json({
            error: `enabledModels pins ${provider}/${modelId} to ${pinned}, so this per-model default would not apply at startup.`,
            reason: "thinking-level-pin",
            thinkingLevel: pinned,
          }, { status: 409 });
        }
      }
    }

    await writeDefaultPreferences(settingsManager, edit, join(agentDir, "settings.json"));
    invalidateModelsCache();
    return Response.json({
      ok: true,
      ...(edit.model ? { defaultModel: edit.model } : {}),
      ...(edit.thinkingLevel ? { defaultThinkingLevel: edit.thinkingLevel } : {}),
      ...(edit.modelThinkingLevel ? { modelThinkingLevel: edit.modelThinkingLevel } : {}),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
