import { useAtomValue } from "@effect/atom-react";
import {
  ModelSelection as ModelSelectionSchema,
  ProviderInteractionMode as ProviderInteractionModeSchema,
  RuntimeMode as RuntimeModeSchema,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { Atom } from "effect/unstable/reactivity";

import { DraftComposerImageAttachmentSchema } from "../lib/composer-image-schema";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";

const COMPOSER_DRAFTS_SCHEMA_VERSION = 2;
const COMPOSER_DRAFTS_DIRECTORY = "composer-drafts";
const COMPOSER_DRAFTS_FILE = "drafts.json";
const COMPOSER_DRAFTS_TEMP_FILE = "drafts.next.json";
const PERSIST_DEBOUNCE_MS = 200;
export const MAXIMUM_APPLIED_VOICE_ARTIFACTS = 4_096;

export class ComposerDraftPersistenceError extends Schema.TaggedErrorClass<ComposerDraftPersistenceError>()(
  "ComposerDraftPersistenceError",
  {
    operation: Schema.Literals(["open", "read", "decode", "encode", "write", "hydrate"]),
    directory: Schema.String,
    fileName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Composer draft persistence operation ${this.operation} failed for ${this.directory}/${this.fileName}.`;
  }
}

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly workspaceSelection?: ComposerDraftWorkspaceSelection;
}

export interface ComposerDraftWorkspaceSelection {
  readonly mode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin?: boolean;
}

export type ComposerDraftSettingsUpdate = Pick<
  ComposerDraft,
  "modelSelection" | "runtimeMode" | "interactionMode" | "workspaceSelection"
>;

const ComposerDraftWorkspaceSelectionSchema = Schema.Struct({
  mode: Schema.Literals(["local", "worktree"]),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ComposerDraftSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.Array(DraftComposerImageAttachmentSchema),
  modelSelection: Schema.optional(ModelSelectionSchema),
  runtimeMode: Schema.optional(RuntimeModeSchema),
  interactionMode: Schema.optional(ProviderInteractionModeSchema),
  workspaceSelection: Schema.optional(ComposerDraftWorkspaceSelectionSchema),
});

const PersistedVoiceArtifactApplicationSchema = Schema.Struct({
  draftKey: Schema.String,
  appliedAtEpochMillis: Schema.Number,
  expiresAtEpochMillis: Schema.Number,
});

const PersistedComposerDraftsV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
});

const PersistedComposerDraftsV2Schema = Schema.Struct({
  schemaVersion: Schema.Literal(COMPOSER_DRAFTS_SCHEMA_VERSION),
  drafts: Schema.Record(Schema.String, ComposerDraftSchema),
  appliedVoiceArtifacts: Schema.Record(Schema.String, PersistedVoiceArtifactApplicationSchema),
});

const decodePersistedComposerDraftsDocument = Schema.decodeUnknownSync(
  Schema.Union([PersistedComposerDraftsV1Schema, PersistedComposerDraftsV2Schema]),
);

export interface PersistedVoiceArtifactApplication {
  readonly draftKey: string;
  readonly appliedAtEpochMillis: number;
  readonly expiresAtEpochMillis: number;
}

export interface ComposerDraftsPersistenceState {
  readonly drafts: Record<string, ComposerDraft>;
  readonly appliedVoiceArtifacts: Record<string, PersistedVoiceArtifactApplication>;
}

export interface ApplyVoiceArtifactInput {
  readonly draftKey: string;
  readonly artifactId: string;
  readonly transcript: string;
  readonly appliedAtEpochMillis: number;
  readonly expiresAtEpochMillis: number;
}

export interface ApplyVoiceArtifactResult {
  readonly outcome: "appended" | "already-applied";
  readonly draft: ComposerDraft;
}

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
};

export const composerDraftsAtom = Atom.make<Record<string, ComposerDraft>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:composer-drafts"),
);

let loadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();
let appliedVoiceArtifacts: Record<string, PersistedVoiceArtifactApplication> = {};

function normalizeDraft(draft: ComposerDraft | undefined): ComposerDraft {
  if (!draft) {
    return EMPTY_DRAFT;
  }
  return {
    ...draft,
    text: draft.text,
    attachments: draft.attachments,
  };
}

export function getComposerDraftSnapshot(draftKey: string): ComposerDraft {
  return normalizeDraft(appAtomRegistry.get(composerDraftsAtom)[draftKey]);
}

export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return isEmptyDraft(draft);
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text.length === 0 &&
    draft.attachments.length === 0 &&
    draft.modelSelection === undefined &&
    draft.runtimeMode === undefined &&
    draft.interactionMode === undefined &&
    draft.workspaceSelection === undefined
  );
}

export function decodePersistedComposerDraftsState(
  value: unknown,
  now = Date.now(),
): ComposerDraftsPersistenceState {
  const parsed = decodePersistedComposerDraftsDocument(value);
  return {
    drafts: Object.fromEntries(
      Object.entries(parsed.drafts).filter(([, draft]) => !isEmptyDraft(draft)),
    ),
    appliedVoiceArtifacts:
      parsed.schemaVersion === 1
        ? {}
        : pruneAppliedVoiceArtifacts(parsed.appliedVoiceArtifacts, now),
  };
}

export function decodePersistedComposerDrafts(value: unknown): Record<string, ComposerDraft> {
  return decodePersistedComposerDraftsState(value).drafts;
}

export function applyVoiceArtifactToState(
  state: ComposerDraftsPersistenceState,
  input: ApplyVoiceArtifactInput,
): { readonly state: ComposerDraftsPersistenceState; readonly result: ApplyVoiceArtifactResult } {
  const existing = normalizeDraft(state.drafts[input.draftKey]);
  const liveApplications = pruneAppliedVoiceArtifacts(
    state.appliedVoiceArtifacts,
    input.appliedAtEpochMillis,
  );
  if (liveApplications[input.artifactId] !== undefined) {
    return {
      state: { ...state, appliedVoiceArtifacts: liveApplications },
      result: { outcome: "already-applied", draft: existing },
    };
  }

  const prefix =
    existing.text.length === 0 || /\s$/.test(existing.text) ? existing.text : `${existing.text} `;
  const draft = {
    ...existing,
    text: `${prefix}${input.transcript}`,
  };
  return {
    state: {
      drafts: {
        ...state.drafts,
        [input.draftKey]: draft,
      },
      appliedVoiceArtifacts: pruneAppliedVoiceArtifacts(
        {
          ...liveApplications,
          [input.artifactId]: {
            draftKey: input.draftKey,
            appliedAtEpochMillis: input.appliedAtEpochMillis,
            expiresAtEpochMillis: input.expiresAtEpochMillis,
          },
        },
        input.appliedAtEpochMillis,
      ),
    },
    result: { outcome: "appended", draft },
  };
}

async function getComposerDraftsFile() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(directory, COMPOSER_DRAFTS_FILE);
}

async function loadPersistedComposerDrafts(): Promise<ComposerDraftsPersistenceState> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const file = await getComposerDraftsFile();
    if (!file.exists) {
      return { drafts: {}, appliedVoiceArtifacts: {} };
    }
    operation = "read";
    const raw = await file.text();
    operation = "decode";
    return decodePersistedComposerDraftsState(JSON.parse(raw) as unknown);
  } catch (cause) {
    console.warn(
      "[composer-drafts] ignored persisted draft failure",
      new ComposerDraftPersistenceError({
        operation,
        directory: COMPOSER_DRAFTS_DIRECTORY,
        fileName: COMPOSER_DRAFTS_FILE,
        cause,
      }),
    );
    return { drafts: {}, appliedVoiceArtifacts: {} };
  }
}

function pruneAppliedVoiceArtifacts(
  applications: Record<string, PersistedVoiceArtifactApplication>,
  now: number,
): Record<string, PersistedVoiceArtifactApplication> {
  return Object.fromEntries(
    Object.entries(applications)
      .filter(([, application]) => application.expiresAtEpochMillis > now)
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.appliedAtEpochMillis - right.appliedAtEpochMillis || leftId.localeCompare(rightId),
      )
      .slice(-MAXIMUM_APPLIED_VOICE_ARTIFACTS),
  );
}

export function encodePersistedComposerDraftsState(
  state: ComposerDraftsPersistenceState,
  now = Date.now(),
) {
  return {
    schemaVersion: COMPOSER_DRAFTS_SCHEMA_VERSION,
    drafts: Object.fromEntries(
      Object.entries(state.drafts).filter(([, draft]) => !isEmptyDraft(draft)),
    ),
    appliedVoiceArtifacts: pruneAppliedVoiceArtifacts(state.appliedVoiceArtifacts, now),
  } as const;
}

async function writePersistedComposerDrafts(state: ComposerDraftsPersistenceState): Promise<void> {
  let operation: ComposerDraftPersistenceError["operation"] = "open";
  try {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, COMPOSER_DRAFTS_DIRECTORY);
    directory.create({ idempotent: true, intermediates: true });
    const file = new File(directory, COMPOSER_DRAFTS_FILE);
    const temporaryFile = new File(directory, COMPOSER_DRAFTS_TEMP_FILE);
    operation = "encode";
    const encoded = JSON.stringify(encodePersistedComposerDraftsState(state));
    operation = "write";
    temporaryFile.create({ intermediates: true, overwrite: true });
    temporaryFile.write(encoded);
    await temporaryFile.move(file, { overwrite: true });
  } catch (cause) {
    throw new ComposerDraftPersistenceError({
      operation,
      directory: COMPOSER_DRAFTS_DIRECTORY,
      fileName: COMPOSER_DRAFTS_FILE,
      cause,
    });
  }
}

function enqueuePersistedComposerDrafts(state: ComposerDraftsPersistenceState): Promise<void> {
  const write = persistenceQueue.then(() => writePersistedComposerDrafts(state));
  persistenceQueue = write.catch(() => undefined);
  return write;
}

async function savePersistedComposerDrafts(state: ComposerDraftsPersistenceState): Promise<void> {
  try {
    await enqueuePersistedComposerDrafts(state);
  } catch (error) {
    console.warn("[composer-drafts] failed to persist drafts", error);
    // Draft persistence is best-effort; in-memory drafts still keep working.
  }
}

function schedulePersistComposerDrafts(drafts: Record<string, ComposerDraft>): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void savePersistedComposerDrafts({ drafts, appliedVoiceArtifacts });
  }, PERSIST_DEBOUNCE_MS);
}

export function ensureComposerDraftsLoaded(): void {
  if (loadPromise !== null) {
    return;
  }
  loadPromise = loadPersistedComposerDrafts()
    .then((persisted) => {
      appliedVoiceArtifacts = {
        ...persisted.appliedVoiceArtifacts,
        ...appliedVoiceArtifacts,
      };
      if (Object.keys(persisted.drafts).length === 0) return;
      const current = appAtomRegistry.get(composerDraftsAtom);
      appAtomRegistry.set(composerDraftsAtom, {
        ...persisted.drafts,
        ...current,
      });
    })
    .catch((cause) => {
      console.warn(
        "[composer-drafts] failed to hydrate drafts",
        new ComposerDraftPersistenceError({
          operation: "hydrate",
          directory: COMPOSER_DRAFTS_DIRECTORY,
          fileName: COMPOSER_DRAFTS_FILE,
          cause,
        }),
      );
      // Draft loading is best-effort; in-memory drafts still keep working.
    });
}

async function awaitComposerDraftsLoaded(): Promise<void> {
  ensureComposerDraftsLoaded();
  await loadPromise;
}

export async function applyVoiceArtifact(
  input: ApplyVoiceArtifactInput,
): Promise<ApplyVoiceArtifactResult> {
  await awaitComposerDraftsLoaded();
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  const currentDrafts = appAtomRegistry.get(composerDraftsAtom);
  const applied = applyVoiceArtifactToState(
    { drafts: currentDrafts, appliedVoiceArtifacts },
    input,
  );
  appliedVoiceArtifacts = applied.state.appliedVoiceArtifacts;
  appAtomRegistry.set(composerDraftsAtom, applied.state.drafts);
  await enqueuePersistedComposerDrafts(applied.state);
  return applied.result;
}

function updateComposerDrafts(
  update: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
): void {
  const next = update(appAtomRegistry.get(composerDraftsAtom));
  appAtomRegistry.set(composerDraftsAtom, next);
  schedulePersistComposerDrafts(next);
}

export function setComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      text: value,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function appendComposerDraftText(draftKey: string, value: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        text: `${existing.text}${value}`,
      },
    };
  });
}

export function appendComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  if (attachments.length === 0) {
    return;
  }
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    return {
      ...current,
      [draftKey]: {
        ...existing,
        attachments: [...existing.attachments, ...attachments],
      },
    };
  });
}

export function replaceComposerDraftAttachments(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      attachments,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function removeComposerDraftAttachment(draftKey: string, imageId: string): void {
  updateComposerDrafts((current) => {
    const existing = normalizeDraft(current[draftKey]);
    const draft = {
      ...existing,
      attachments: existing.attachments.filter((image) => image.id !== imageId),
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function updateComposerDraftSettings(
  draftKey: string,
  settings: Partial<ComposerDraftSettingsUpdate>,
): void {
  updateComposerDrafts((current) => {
    const draft = {
      ...normalizeDraft(current[draftKey]),
      ...settings,
    };
    if (isEmptyDraft(draft)) {
      const next = { ...current };
      delete next[draftKey];
      return next;
    }
    return {
      ...current,
      [draftKey]: draft,
    };
  });
}

export function clearComposerDraftContentState(
  current: Record<string, ComposerDraft>,
  draftKey: string,
): Record<string, ComposerDraft> {
  const existing = current[draftKey];
  if (!existing) {
    return current;
  }
  const draft = {
    ...existing,
    text: "",
    attachments: [],
  };
  if (isEmptyDraft(draft)) {
    const next = { ...current };
    delete next[draftKey];
    return next;
  }
  return {
    ...current,
    [draftKey]: draft,
  };
}

export function clearComposerDraftContent(draftKey: string): void {
  updateComposerDrafts((current) => clearComposerDraftContentState(current, draftKey));
}

export function clearComposerDraft(draftKey: string): void {
  updateComposerDrafts((current) => {
    if (!current[draftKey]) {
      return current;
    }
    const next = { ...current };
    delete next[draftKey];
    return next;
  });
}

export function removeComposerDraftsForEnvironment(
  drafts: Record<string, ComposerDraft>,
  environmentId: EnvironmentId,
): Record<string, ComposerDraft> {
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  return Object.fromEntries(
    Object.entries(drafts).filter(
      ([draftKey]) =>
        !draftKey.startsWith(environmentPrefix) && !draftKey.startsWith(newTaskPrefix),
    ),
  );
}

export async function clearComposerDraftsEnvironment(environmentId: EnvironmentId): Promise<void> {
  await awaitComposerDraftsLoaded();

  const next = removeComposerDraftsForEnvironment(
    appAtomRegistry.get(composerDraftsAtom),
    environmentId,
  );

  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const environmentPrefix = `${environmentId}:`;
  const newTaskPrefix = `new-task:${environmentId}:`;
  appliedVoiceArtifacts = Object.fromEntries(
    Object.entries(appliedVoiceArtifacts).filter(
      ([, application]) =>
        !application.draftKey.startsWith(environmentPrefix) &&
        !application.draftKey.startsWith(newTaskPrefix),
    ),
  );
  appAtomRegistry.set(composerDraftsAtom, next);
  await enqueuePersistedComposerDrafts({ drafts: next, appliedVoiceArtifacts });
}

export function useComposerDraft(draftKey: string | null): ComposerDraft {
  const drafts = useAtomValue(composerDraftsAtom);
  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);
  return draftKey ? normalizeDraft(drafts[draftKey]) : EMPTY_DRAFT;
}
