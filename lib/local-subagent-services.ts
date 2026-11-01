import {
  createAgentSessionServices,
  SettingsManager,
  type CreateAgentSessionServicesOptions,
  type AgentSessionServices,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { localSubagentExtensionPaths, type LocalSubagentPolicy } from "./local-subagent-policy";

/** Public ResourceLoader adapter: all reload entry points must recheck explicit local files. */
function guardedLocalResources(loader: ResourceLoader, policy: LocalSubagentPolicy): ResourceLoader {
  return {
    getExtensions: () => loader.getExtensions(),
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getSystemPromptSource: () => loader.getSystemPromptSource(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: (paths) => loader.extendResources(paths),
    reload: async (options) => {
      localSubagentExtensionPaths(policy);
      await loader.reload(options);
    },
  };
}

/**
 * Full/profile sessions keep normal SDK loading. Limited children use a private, empty resource
 * settings manager: noExtensions alone is too late, since SDK package resolution can install
 * configured packages (and run lifecycle scripts) before filtering discovered extensions.
 * The session itself retains its real settings for models, reasoning, shell preferences, etc.
 */
export async function createLocalSubagentServices(
  options: CreateAgentSessionServicesOptions,
  policy?: LocalSubagentPolicy,
): Promise<AgentSessionServices> {
  if (!policy) return createAgentSessionServices(options);
  if (!options.settingsManager) throw new Error("Local subagent services require session settings");
  const ceiling = { ...policy, builtins: [...policy.builtins] };
  // Validate before the SDK's initial reload too, not just subsequent calls through the adapter.
  const additionalExtensionPaths = localSubagentExtensionPaths(ceiling);
  const services = await createAgentSessionServices({
    ...options,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoaderOptions: {
      ...options.resourceLoaderOptions,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths,
    },
  });
  return {
    ...services,
    settingsManager: options.settingsManager,
    resourceLoader: guardedLocalResources(services.resourceLoader, ceiling),
  };
}
