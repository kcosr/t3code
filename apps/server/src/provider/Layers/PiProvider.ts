/**
 * PiProvider — health snapshots, version probe, and model discovery for stock Pi.
 *
 * @module PiProvider
 */

import {
  type ModelCapabilities,
  type PiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  encodePiModelSlug,
  getSupportedPiThinkingLevels,
  type PiThinkingLevel,
} from "../pi/modelSlug.ts";
import { extractPiVersion, isSupportedPiVersion, PI_COMPATIBILITY } from "../pi/version.ts";
import { buildPiEnvironment, makePiSessionRuntime } from "./PiSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  // In-session model/thinking apply via RPC set_model / set_thinking_level.
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function thinkingOptionDescriptor(
  levels: ReadonlyArray<PiThinkingLevel>,
): ModelCapabilities["optionDescriptors"] {
  if (levels.length === 0) {
    return [];
  }
  const defaultLevel = levels.includes("off")
    ? "off"
    : levels.includes("medium")
      ? "medium"
      : levels[0]!;
  return [
    {
      id: "thinkingLevel",
      label: "Thinking",
      description: "Pi reasoning / thinking level for this model.",
      type: "select" as const,
      options: levels.map((level) => ({
        id: level,
        label: THINKING_LEVEL_LABELS[level] ?? level,
        ...(level === defaultLevel ? { isDefault: true } : {}),
      })),
    },
  ];
}

function capabilitiesForPiModel(model: {
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
}): ModelCapabilities {
  const levels = getSupportedPiThinkingLevels(model);
  if (levels.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  return createModelCapabilities({
    optionDescriptors: thinkingOptionDescriptor(levels) ?? [],
  });
}

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, PROVIDER, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);
    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

const runPiVersionCommand = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(command, ["--version"], {
        env: environment,
      }),
    );
  });

function normalizeDiscoveredModels(
  models: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const out: ServerProviderModel[] = [];
  for (const model of models) {
    const provider = typeof model.provider === "string" ? model.provider.trim() : "";
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!provider || !id) continue;
    const slug = encodePiModelSlug(provider, id);
    if (seen.has(slug)) continue;
    seen.add(slug);
    const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
    out.push({
      slug,
      name,
      isCustom: false,
      capabilities: capabilitiesForPiModel({
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
      }),
    });
  }
  return out;
}

const discoverPiModels = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const env = buildPiEnvironment(piSettings, environment);
    const runtime = yield* makePiSessionRuntime({
      spawn: {
        binaryPath: piSettings.binaryPath || "pi",
        cwd: process.cwd(),
        environment: env,
        noSession: true,
        noTools: true,
        projectTrust: piSettings.projectTrust,
        sessionDir: piSettings.sessionDir?.trim() || undefined,
      },
    });
    yield* runtime.start();
    const models = yield* runtime.getAvailableModels();
    yield* runtime.close;
    return normalizeDiscoveredModels(models);
  }).pipe(Effect.scoped);

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);
  const processEnv = buildPiEnvironment(piSettings, environment);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, processEnv).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version =
    extractPiVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`) ??
    parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but `pi --version` failed.",
      },
    });
  }

  if (version && !isSupportedPiVersion(version)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi version ${version} is outside the supported range (${PI_COMPATIBILITY.testedRange}).`,
      },
    });
  }

  const discovery = yield* discoverPiModels(piSettings, processEnv).pipe(
    Effect.timeoutOption(Duration.millis(MODEL_DISCOVERY_TIMEOUT_MS)),
    Effect.result,
  );

  if (Result.isFailure(discovery)) {
    yield* Effect.logWarning("Pi model discovery failed", {
      detail: String(discovery.failure),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Pi CLI is ready but model discovery failed. Authenticate providers in Pi (agent dir) or check API keys.",
      },
    });
  }

  if (Option.isNone(discovery.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: `Pi model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const discoveredModels = discovery.success.value;
  const models = piModelsFromSettings(piSettings.customModels, discoveredModels);

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: discoveredModels.length > 0 ? "ready" : "warning",
      auth: { status: discoveredModels.length > 0 ? "authenticated" : "unknown" },
      ...(discoveredModels.length === 0
        ? {
            message:
              "Pi CLI is ready but no models were returned. Configure provider auth in Pi (PI_CODING_AGENT_DIR / agent login).",
          }
        : {}),
    },
  });
});
