/**
 * PiTextGeneration — no-session, no-tools utility generation via stock Pi RPC.
 *
 * @module PiTextGeneration
 */

import { type ModelSelection, type PiSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { parsePiModelSlug } from "../provider/pi/modelSlug.ts";
import { buildPiEnvironment, makePiSessionRuntime } from "../provider/Layers/PiSessionRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const parsed = parsePiModelSlug(modelSelection.model);
      const env = buildPiEnvironment(piSettings, environment);
      const assistantTextRef = yield* Ref.make("");
      const done = yield* Deferred.make<void>();

      const runtime = yield* makePiSessionRuntime({
        spawn: {
          binaryPath: piSettings.binaryPath || "pi",
          cwd,
          environment: env,
          noSession: true,
          noTools: true,
          projectTrust: piSettings.projectTrust,
          sessionDir: piSettings.sessionDir?.trim() || undefined,
          ...(parsed ? { provider: parsed.provider, model: parsed.modelId } : {}),
        },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
        Effect.gen(function* () {
          if (event.type === "agent_end" || event.type === "t3.pi.process_exit") {
            yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "message_update") return;
          const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!ame || ame.type !== "text_delta") return;
          if (typeof ame.delta !== "string" || ame.delta.length === 0) return;
          yield* Ref.update(assistantTextRef, (prev) => `${prev}${ame.delta}`);
        }),
      ).pipe(Effect.forkScoped);

      yield* runtime.start().pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Pi utility session failed to start: ${cause.message}`,
              cause,
            }),
        ),
      );

      yield* runtime
        .prompt({
          message: `${prompt}\n\nRespond with JSON only, no markdown fences.`,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Pi utility prompt failed: ${cause.message}`,
                cause,
              }),
          ),
        );

      yield* Deferred.await(done).pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Pi utility generation timed out.",
                }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      yield* Fiber.interrupt(eventFiber).pipe(Effect.ignore);
      yield* runtime.close.pipe(Effect.ignore);

      const text = (yield* Ref.get(assistantTextRef)).trim();
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: "Pi utility generation returned empty assistant text.",
        });
      }

      const json = extractJsonObject(text);
      if (!json) {
        return yield* new TextGenerationError({
          operation,
          detail: "Pi utility generation did not return a JSON object.",
        });
      }

      return yield* Schema.decodeUnknownEffect(outputSchemaJson)(json).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to decode Pi utility JSON: ${String(cause)}`,
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Pi utility text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
