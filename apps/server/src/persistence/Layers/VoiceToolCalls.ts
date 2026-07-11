import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DurableVoiceToolCall,
  VoiceToolCallRepository,
  type VoiceToolCallRepositoryShape,
} from "../Services/VoiceToolCalls.ts";

const ToolCallRow = DurableVoiceToolCall;
const Key = Schema.Struct({ conversationId: Schema.String, toolCallId: Schema.String });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const find = SqlSchema.findOneOption({
    Request: Key,
    Result: ToolCallRow,
    execute: (input) => sql`
      SELECT
        conversation_id AS "conversationId",
        tool_call_id AS "toolCallId",
        provider_function_call_id AS "providerFunctionCallId",
        tool_name AS "toolName",
        canonical_arguments_json AS "canonicalArgumentsJson",
        status,
        session_id AS "sessionId",
        confirmation_id AS "confirmationId",
        summary,
        command_id AS "commandId",
        command_json AS "commandJson",
        result_output AS "resultOutput",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt"
      FROM voice_tool_calls
      WHERE conversation_id = ${input.conversationId}
        AND tool_call_id = ${input.toolCallId}
      LIMIT 1
    `,
  });

  const findByConfirmation = SqlSchema.findOneOption({
    Request: Schema.Struct({ confirmationId: Schema.String }),
    Result: ToolCallRow,
    execute: ({ confirmationId }) => sql`
      SELECT
        conversation_id AS "conversationId",
        tool_call_id AS "toolCallId",
        provider_function_call_id AS "providerFunctionCallId",
        tool_name AS "toolName",
        canonical_arguments_json AS "canonicalArgumentsJson",
        status,
        session_id AS "sessionId",
        confirmation_id AS "confirmationId",
        summary,
        command_id AS "commandId",
        command_json AS "commandJson",
        result_output AS "resultOutput",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt"
      FROM voice_tool_calls
      WHERE confirmation_id = ${confirmationId}
      LIMIT 1
    `,
  });

  const getRequired = (key: typeof Key.Type) =>
    find(key).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceToolCallRepository.get:query")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error("Voice tool call disappeared during persistence")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const insertRequested = SqlSchema.findOneOption({
    Request: Schema.Struct({
      conversationId: Schema.String,
      toolCallId: Schema.String,
      providerFunctionCallId: Schema.String,
      toolName: Schema.String,
      canonicalArgumentsJson: Schema.String,
      sessionId: Schema.String,
      createdAt: Schema.String,
    }),
    Result: Key,
    execute: (input) => sql`
      INSERT INTO voice_tool_calls (
        conversation_id, tool_call_id, provider_function_call_id, tool_name,
        canonical_arguments_json, status, session_id, created_at, updated_at
      ) VALUES (
        ${input.conversationId}, ${input.toolCallId}, ${input.providerFunctionCallId},
        ${input.toolName}, ${input.canonicalArgumentsJson}, 'requested', ${input.sessionId},
        ${input.createdAt}, ${input.createdAt}
      )
      ON CONFLICT (conversation_id, tool_call_id) DO NOTHING
      RETURNING conversation_id AS "conversationId", tool_call_id AS "toolCallId"
    `,
  });

  const updatePending = SqlSchema.void({
    Request: Schema.Struct({
      conversationId: Schema.String,
      toolCallId: Schema.String,
      sessionId: Schema.String,
      confirmationId: Schema.String,
      summary: Schema.String,
      commandId: Schema.String,
      commandJson: Schema.String,
      updatedAt: Schema.String,
      expiresAt: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE voice_tool_calls
      SET status = 'pending-confirmation',
          session_id = ${input.sessionId},
          confirmation_id = ${input.confirmationId},
          summary = ${input.summary},
          command_id = ${input.commandId},
          command_json = ${input.commandJson},
          updated_at = ${input.updatedAt},
          expires_at = ${input.expiresAt}
      WHERE conversation_id = ${input.conversationId}
        AND tool_call_id = ${input.toolCallId}
        AND status = 'requested'
    `,
  });

  const updateTerminal = SqlSchema.void({
    Request: Schema.Struct({
      conversationId: Schema.String,
      toolCallId: Schema.String,
      status: Schema.String,
      resultOutput: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE voice_tool_calls
      SET status = ${input.status},
          result_output = ${input.resultOutput},
          updated_at = ${input.updatedAt}
      WHERE conversation_id = ${input.conversationId}
        AND tool_call_id = ${input.toolCallId}
        AND status IN ('requested', 'pending-confirmation')
    `,
  });

  const createRequested: VoiceToolCallRepositoryShape["createRequested"] = (input) =>
    insertRequested(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceToolCallRepository.createRequested:insert")),
      Effect.flatMap((inserted) =>
        getRequired(input).pipe(Effect.map((call) => ({ call, created: Option.isSome(inserted) }))),
      ),
    );
  const get: VoiceToolCallRepositoryShape["get"] = (input) =>
    find(input).pipe(Effect.mapError(toPersistenceSqlError("VoiceToolCallRepository.get:query")));
  const getByConfirmationId: VoiceToolCallRepositoryShape["getByConfirmationId"] = (
    confirmationId,
  ) =>
    findByConfirmation({ confirmationId }).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceToolCallRepository.getByConfirmationId:query")),
    );
  const markPending: VoiceToolCallRepositoryShape["markPending"] = (input) =>
    updatePending(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceToolCallRepository.markPending:update")),
      Effect.andThen(getRequired(input)),
    );
  const markTerminal: VoiceToolCallRepositoryShape["markTerminal"] = (input) =>
    updateTerminal(input).pipe(
      Effect.mapError(toPersistenceSqlError("VoiceToolCallRepository.markTerminal:update")),
      Effect.andThen(getRequired(input)),
    );

  return VoiceToolCallRepository.of({
    createRequested,
    get,
    getByConfirmationId,
    markPending,
    markTerminal,
  });
});

export const VoiceToolCallRepositoryLive = Layer.effect(VoiceToolCallRepository, make);
