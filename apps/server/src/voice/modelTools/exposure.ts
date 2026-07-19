import type { VoiceCommandToolName } from "@t3tools/contracts";
import type { AnyModelToolDefinition, ModelToolRegistry } from "@t3tools/shared/model-tool";

import {
  VOICE_COMMAND_CAPABLE_TOOL_NAMES,
  type VoiceMigratedToolName,
  VoiceModelTools,
} from "./definitions.ts";

export type VoiceCommandToolSet = ReadonlySet<VoiceCommandToolName>;

export interface VoiceToolExposure {
  /** Migrated tools exposed as direct Realtime function tools. */
  readonly directMigratedTools: ReadonlyArray<AnyModelToolDefinition>;
  /** Migrated tools available only through the command wrapper. */
  readonly commandCatalog: ReadonlyArray<AnyModelToolDefinition>;
  /** True when command meta-tools should be advertised to the provider. */
  readonly commandMetaToolsEnabled: boolean;
  /** Session-stable set of command-only business tool names. */
  readonly commandTools: VoiceCommandToolSet;
}

/**
 * Resolve session exposure for migrated voice tools.
 *
 * Membership in `commandTools` suppresses the corresponding direct declaration
 * and places the tool in the command catalog. Meta-tools are present only when
 * the command catalog is non-empty.
 */
export function resolveVoiceToolExposure(
  commandTools: ReadonlyArray<VoiceCommandToolName>,
  registry: ModelToolRegistry<readonly AnyModelToolDefinition[]> = VoiceModelTools,
): VoiceToolExposure {
  const commandSet = new Set<VoiceCommandToolName>(commandTools);
  for (const name of commandSet) {
    if (!VOICE_COMMAND_CAPABLE_TOOL_NAMES.includes(name as VoiceMigratedToolName)) {
      throw new Error(`Unknown command tool configured for voice exposure: ${name}`);
    }
    if (registry.get(name) === undefined) {
      throw new Error(`Command tool "${name}" is not registered`);
    }
  }

  const directMigratedTools: AnyModelToolDefinition[] = [];
  const commandCatalog: AnyModelToolDefinition[] = [];
  for (const tool of registry.tools) {
    if (commandSet.has(tool.name as VoiceCommandToolName)) {
      commandCatalog.push(tool);
    } else {
      directMigratedTools.push(tool);
    }
  }

  commandCatalog.sort((left, right) => left.name.localeCompare(right.name));

  return {
    directMigratedTools,
    commandCatalog,
    commandMetaToolsEnabled: commandCatalog.length > 0,
    commandTools: commandSet,
  };
}

export function isCommandOnlyTool(
  exposure: VoiceToolExposure,
  name: string,
): name is VoiceCommandToolName {
  return exposure.commandTools.has(name as VoiceCommandToolName);
}
