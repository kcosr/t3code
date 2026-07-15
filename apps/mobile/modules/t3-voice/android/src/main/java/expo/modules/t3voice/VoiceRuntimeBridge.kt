package expo.modules.t3voice

import java.time.Instant
import org.json.JSONObject

internal object VoiceRuntimeBridge {
  data class ParsedAuthority(
    val reservation: VoiceRuntimeAuthorityReservation,
    val target: VoiceRuntimeTarget,
    val environmentOrigin: String,
    val readinessEnabled: Boolean,
    val fingerprint: String,
  )
  fun canonicalRealtimeTargetIdentity(target: VoiceRuntimeTarget.Realtime): String = canonicalJson(
    mapOf(
      "mode" to "realtime",
      "environmentId" to target.environmentId,
      "conversationId" to target.conversationId,
    ),
  )
  fun canonicalThreadTargetIdentity(target: VoiceRuntimeTarget.Thread): String = canonicalJson(
    mapOf(
      "mode" to "thread",
      "environmentId" to target.environmentId,
      "projectId" to target.projectId,
      "threadId" to target.threadId,
      "speechPreset" to target.speechPreset,
      "autoRearm" to target.autoRearm,
      "endpointPolicy" to mapOf(
        "endSilenceMs" to target.endSilenceMs,
        "noSpeechTimeoutMs" to target.noSpeechTimeoutMs,
        "maximumUtteranceMs" to target.maximumUtteranceMs,
      ),
      "speechEnabled" to target.speechEnabled,
      "rearmGuardMs" to target.rearmGuardMs,
    ),
  )

  private fun canonicalJson(value: Any?): String = when (value) {
    null -> "null"
    is Map<*, *> -> value.entries.sortedBy { it.key.toString() }.joinToString(",", "{", "}") {
      "${JSONObject.quote(it.key.toString())}:${canonicalJson(it.value)}"
    }
    is Iterable<*> -> value.joinToString(",", "[", "]") { canonicalJson(it) }
    is String -> JSONObject.quote(value)
    is Boolean, is Number -> value.toString()
    else -> throw IllegalArgumentException("Unsupported canonical voice target value.")
  }

  fun descriptorBody(): Map<String, Any> = mapOf(
    "protocolMajor" to 2,
    "executionModel" to "autonomous",
    "capabilities" to mapOf(
      "automaticEndpointing" to true,
      "recordingFormats" to listOf("audio/mp4"),
      "playbackFormats" to listOf(
        mapOf("encoding" to "pcm-s16le", "sampleRates" to listOf(24_000), "channelCounts" to listOf(1)),
      ),
      "realtimeWebRtc" to true,
      "persistentReadiness" to true,
      "notificationControl" to true,
      "headsetControl" to true,
      "inputRouteSelection" to false,
      "outputRouteSelection" to false,
    ),
  )

  fun parseAuthority(input: Map<String, Any?>): ParsedAuthority {
    requireKeys(input, setOf(
      "runtimeId", "runtimeInstanceId", "expectedCurrentGeneration", "generation", "target",
      "environmentOrigin", "readinessEnabled",
    ))
    val targetInput = objectValue(input, "target")
    val target = when (text(targetInput, "mode")) {
      "realtime" -> parseRealtimeTarget(targetInput)
      "thread" -> parseThreadTarget(targetInput)
      else -> throw IllegalArgumentException("Unsupported voice runtime authority target.")
    }
    val targetIdentity = when (target) {
      is VoiceRuntimeTarget.Realtime -> canonicalRealtimeTargetIdentity(target)
      is VoiceRuntimeTarget.Thread -> canonicalThreadTargetIdentity(target)
    }
    val targetDigest = T3VoiceRuntimeTargetIdentity.digest(targetIdentity)
    val reservation = VoiceRuntimeAuthorityReservation(
      VoiceRuntimeIdentity(
        text(input, "runtimeId"),
        text(input, "runtimeInstanceId"),
        long(input, "generation"),
      ),
      long(input, "expectedCurrentGeneration"),
      targetDigest,
    )
    val fingerprint = listOf(
      reservation.identity.runtimeId,
      reservation.identity.runtimeInstanceId,
      reservation.identity.generation,
      reservation.expectedCurrentGeneration,
      reservation.targetDigest,
      target,
      boolean(input, "readinessEnabled"),
    ).joinToString("\u0000")
    return ParsedAuthority(
      reservation,
      target,
      VoiceRuntimeOriginPolicy.normalize(text(input, "environmentOrigin")),
      boolean(input, "readinessEnabled"),
      fingerprint,
    )
  }

  fun parseRealtimeTarget(targetInput: Map<String, Any?>): VoiceRuntimeTarget.Realtime {
    requireKeys(targetInput, setOf("mode", "environmentId", "conversationId"))
    require(text(targetInput, "mode") == "realtime")
    return VoiceRuntimeTarget.Realtime(
      text(targetInput, "environmentId"),
      text(targetInput, "conversationId"),
    )
  }

  fun parseThreadTarget(targetInput: Map<String, Any?>): VoiceRuntimeTarget.Thread {
    requireKeys(targetInput, setOf(
      "mode", "environmentId", "projectId", "threadId", "speechPreset", "autoRearm",
      "endpointPolicy", "speechEnabled", "rearmGuardMs",
    ))
    require(text(targetInput, "mode") == "thread")
    val endpoint = objectValue(targetInput, "endpointPolicy")
    requireKeys(endpoint, setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs"))
    val target = VoiceRuntimeTarget.Thread(
      text(targetInput, "environmentId"),
      text(targetInput, "projectId"),
      text(targetInput, "threadId"),
      text(targetInput, "speechPreset"),
      boolean(targetInput, "autoRearm"),
      long(endpoint, "endSilenceMs"),
      nullableLong(endpoint, "noSpeechTimeoutMs"),
      long(endpoint, "maximumUtteranceMs"),
      boolean(targetInput, "speechEnabled"),
      long(targetInput, "rearmGuardMs"),
    )
    require(target.endSilenceMs in 100..30_000)
    require(target.noSpeechTimeoutMs == null || target.noSpeechTimeoutMs in 100..1_800_000)
    require(target.maximumUtteranceMs in 1_000..3_600_000)
    require(target.rearmGuardMs in 0..60_000)
    return target
  }

  fun parsePresentation(value: String): VoiceRuntimePresentation = when (value) {
    "foreground-active" -> VoiceRuntimePresentation.FOREGROUND_ACTIVE
    "visible-inactive" -> VoiceRuntimePresentation.VISIBLE_INACTIVE
    "background" -> VoiceRuntimePresentation.BACKGROUND
    else -> throw IllegalArgumentException("Unknown voice runtime presentation.")
  }

  fun parseLease(input: Map<String, Any?>): VoiceRuntimeConsumerLease {
    requireKeys(input, setOf(
      "leaseId", "runtimeId", "runtimeInstanceId", "generation", "leaseGeneration",
      "attachOrdinal", "presentation", "election", "expiresAt",
    ))
    return VoiceRuntimeConsumerLease(
      text(input, "leaseId"),
      VoiceRuntimeIdentity(
        text(input, "runtimeId"),
        text(input, "runtimeInstanceId"),
        long(input, "generation"),
      ),
      long(input, "leaseGeneration"),
      long(input, "attachOrdinal"),
      parsePresentation(text(input, "presentation")),
      when (text(input, "election")) {
        "elected" -> VoiceRuntimeElection.ELECTED
        "standby" -> VoiceRuntimeElection.STANDBY
        else -> throw IllegalArgumentException("Unknown voice runtime election.")
      },
      Instant.parse(text(input, "expiresAt")).toEpochMilli(),
    )
  }

  fun parseCursor(input: Map<String, Any?>): VoiceRuntimeCursor {
    requireKeys(input, setOf("runtimeId", "runtimeInstanceId", "generation", "sequence"))
    return VoiceRuntimeCursor(
      text(input, "runtimeId"),
      text(input, "runtimeInstanceId"),
      long(input, "generation"),
      long(input, "sequence"),
    )
  }

  fun parseAuthorityClear(input: Map<String, Any?>): Pair<String, VoiceRuntimeIdentity> {
    requireKeys(input, setOf(
      "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
    ))
    return text(input, "commandId") to VoiceRuntimeIdentity(
      text(input, "runtimeId"),
      text(input, "runtimeInstanceId"),
      long(input, "authorityGeneration"),
    )
  }

  fun parseCommand(input: Map<String, Any?>): VoiceRuntimeNativeCommand {
    val kind = text(input, "kind")
    val identity = VoiceRuntimeIdentity(
      text(input, "runtimeId"),
      text(input, "runtimeInstanceId"),
      long(input, "authorityGeneration"),
    )
    val commandId = text(input, "commandId")
    val modeSessionId = text(input, "modeSessionId")
    return when (kind) {
      "start-realtime" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "interruptionPolicy",
        ))
        val interruption = text(input, "interruptionPolicy")
        require(interruption in setOf("reject", "stop-conflicting", "drain-conflicting"))
        VoiceRuntimeNativeCommand.StartRealtime(commandId, identity, modeSessionId, interruption)
      }
      "start-thread-mode" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "turnClientOperationId", "submissionPolicy", "draftContext",
          "interruptionPolicy",
        ))
        val submissionPolicy = text(input, "submissionPolicy")
        require(submissionPolicy in setOf("auto-submit", "draft"))
        val interruptionPolicy = text(input, "interruptionPolicy")
        require(interruptionPolicy in setOf("reject", "stop-conflicting", "drain-conflicting"))
        val draftContext = input["draftContext"]?.let {
          @Suppress("UNCHECKED_CAST")
          val value = it as? Map<String, Any?>
            ?: throw IllegalArgumentException("draftContext must be an object or null.")
          requireKeys(value, setOf("environmentId", "projectId", "threadId", "composerRevision"))
          VoiceRuntimeDraftContext(
            text(value, "environmentId"),
            text(value, "projectId"),
            text(value, "threadId"),
            text(value, "composerRevision"),
          )
        }
        require((submissionPolicy == "draft") == (draftContext != null)) {
          "Draft context must be present exactly for draft submission."
        }
        VoiceRuntimeNativeCommand.Thread(VoiceRuntimeThreadCommand.Start(
          commandId,
          identity,
          modeSessionId,
          text(input, "turnClientOperationId"),
          submissionPolicy,
          draftContext,
          interruptionPolicy,
        ))
      }
      "resume-thread-mode" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "turnClientOperationId",
        ))
        VoiceRuntimeNativeCommand.Thread(VoiceRuntimeThreadCommand.Resume(
          commandId, identity, modeSessionId, text(input, "turnClientOperationId"),
        ))
      }
      "finish-thread-turn" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "turnClientOperationId", "outcome", "draftContext",
        ))
        val outcome = text(input, "outcome")
        require(outcome in setOf("finish-and-submit", "finish-to-draft"))
        val draftContext = input["draftContext"]?.let {
          @Suppress("UNCHECKED_CAST")
          val value = it as? Map<String, Any?>
            ?: throw IllegalArgumentException("draftContext must be an object or null.")
          requireKeys(value, setOf("environmentId", "projectId", "threadId", "composerRevision"))
          VoiceRuntimeDraftContext(
            text(value, "environmentId"), text(value, "projectId"),
            text(value, "threadId"), text(value, "composerRevision"),
          )
        }
        require((outcome == "finish-to-draft") == (draftContext != null))
        VoiceRuntimeNativeCommand.Thread(VoiceRuntimeThreadCommand.Finish(
          commandId,
          identity,
          modeSessionId,
          text(input, "turnClientOperationId"),
          outcome,
          draftContext,
        ))
      }
      "cancel-thread-turn" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "turnClientOperationId",
        ))
        VoiceRuntimeNativeCommand.Thread(VoiceRuntimeThreadCommand.Cancel(
          commandId, identity, modeSessionId, text(input, "turnClientOperationId"),
        ))
      }
      "stop-mode" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "policy",
        ))
        val policy = text(input, "policy")
        require(policy in setOf("immediate", "drain", "pause-after-turn"))
        VoiceRuntimeNativeCommand.StopMode(commandId, identity, modeSessionId, policy)
      }
      "set-realtime-muted" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "muted",
        ))
        VoiceRuntimeNativeCommand.SetRealtimeMuted(
          commandId, identity, modeSessionId, boolean(input, "muted"),
        )
      }
      "set-audio-route" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "inputRouteId", "outputRouteId",
        ))
        VoiceRuntimeNativeCommand.SetAudioRoute(
          commandId,
          identity,
          modeSessionId,
          input["inputRouteId"]?.let { text(input, "inputRouteId") },
          input["outputRouteId"]?.let { text(input, "outputRouteId") },
        )
      }
      "update-realtime-focus" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "focus",
        ))
        val focus = input["focus"]?.let {
          val value = objectValue(input, "focus")
          requireKeys(value, setOf("projectId", "threadId"))
          VoiceRuntimeRealtimeFocus(
            text(value, "projectId"),
            value["threadId"]?.let { text(value, "threadId") },
          )
        }
        VoiceRuntimeNativeCommand.UpdateRealtimeFocus(
          commandId, identity, modeSessionId, focus,
        )
      }
      "decide-realtime-confirmation" -> {
        requireKeys(input, setOf(
          "kind", "commandId", "runtimeId", "runtimeInstanceId", "authorityGeneration",
          "modeSessionId", "lease", "actionId", "confirmationId", "decision",
        ))
        val decision = text(input, "decision")
        require(decision in setOf("approve", "reject"))
        VoiceRuntimeNativeCommand.DecideRealtimeConfirmation(
          commandId,
          identity,
          modeSessionId,
          parseLease(objectValue(input, "lease")),
          text(input, "actionId"),
          text(input, "confirmationId"),
          decision,
        )
      }
      else -> throw IllegalArgumentException("Unsupported Android voice runtime command.")
    }
  }

  fun snapshotBody(snapshot: VoiceRuntimeSnapshot): Map<String, Any?> = mapOf(
    "runtimeId" to snapshot.identity.runtimeId,
    "runtimeInstanceId" to snapshot.identity.runtimeInstanceId,
    "generation" to snapshot.identity.generation.toDouble(),
    "sequence" to snapshot.sequence.toDouble(),
    "availability" to snapshot.availability.name.lowercase(),
    "target" to snapshot.target?.let(::targetBody),
    "operation" to operationBody(snapshot.operation),
    "mediaOwner" to mediaBody(snapshot.mediaOwner, snapshot.operation),
    "readiness" to readinessBody(snapshot.readiness),
    "route" to mapOf(
      "inputRouteId" to snapshot.inputRouteId,
      "outputRouteId" to snapshot.outputRouteId,
    ),
    "failure" to snapshot.failureCode?.let {
      mapOf(
        "code" to it,
        "message" to "Native voice could not continue.",
        "retryable" to true,
        "occurredAt" to iso(System.currentTimeMillis()),
      )
    },
  )

  fun leaseBody(lease: VoiceRuntimeConsumerLease): Map<String, Any> = mapOf(
    "leaseId" to lease.leaseId,
    "runtimeId" to lease.identity.runtimeId,
    "runtimeInstanceId" to lease.identity.runtimeInstanceId,
    "generation" to lease.identity.generation.toDouble(),
    "leaseGeneration" to lease.leaseGeneration.toDouble(),
    "attachOrdinal" to lease.attachOrdinal.toDouble(),
    "presentation" to presentationWire(lease.presentation),
    "election" to lease.election.name.lowercase(),
    "expiresAt" to iso(lease.expiresAtEpochMillis),
  )

  fun deliveryBody(delivery: VoiceRuntimeDelivery): Map<String, Any?> = when (delivery) {
    is VoiceRuntimeDelivery.Events -> mapOf(
      "type" to "events",
      "events" to delivery.events.map(::eventBody),
    )
    is VoiceRuntimeDelivery.Rebase -> mapOf(
      "type" to "rebase",
      "reason" to when (delivery.reason) {
        VoiceRuntimeRebaseReason.CURSOR_TOO_OLD -> "cursor-too-old"
        VoiceRuntimeRebaseReason.RUNTIME_REPLACED -> "runtime-replaced"
        VoiceRuntimeRebaseReason.GENERATION_CHANGED -> "generation-changed"
      },
      "cursor" to cursorBody(delivery.cursor),
      "snapshot" to snapshotBody(delivery.snapshot),
      "threadReceipts" to delivery.threadReceipts.map(::threadReceiptBody),
      "realtimeTerminalSummaries" to
        delivery.realtimeTerminalSummaries.map(::realtimeTerminalSummaryBody),
      "draftArtifacts" to delivery.draftArtifacts.map(::draftHandleBody),
      "presentationActions" to delivery.presentationActions.map(::presentationActionBody),
    )
  }

  fun receiptBody(receipt: VoiceRuntimeCommandReceipt): Map<String, Any?> = mapOf(
    "commandId" to receipt.commandId,
    "root" to mapOf("kind" to "mode", "modeSessionId" to receipt.modeSessionId),
    "replayed" to receipt.replayed,
    "outcome" to outcomeBody(receipt.outcome),
    "cursor" to cursorBody(receipt.cursor),
  )

  private fun eventBody(event: VoiceRuntimeEvent): Map<String, Any?> {
    val base = mutableMapOf<String, Any?>(
      "runtimeId" to event.cursor.runtimeId,
      "runtimeInstanceId" to event.cursor.runtimeInstanceId,
      "authorityGeneration" to event.cursor.generation.toDouble(),
      "sequence" to event.cursor.sequence.toDouble(),
      "occurredAt" to iso(event.occurredAtEpochMillis),
      "root" to if (event.rootOperationId == null) mapOf("kind" to "none") else
        mapOf("kind" to "mode", "modeSessionId" to event.rootOperationId),
      "kind" to event.kind,
    )
    event.causedByCommandId?.let { base["causedByCommandId"] = it }
    event.snapshot?.let { base["snapshot"] = snapshotBody(it) }
    event.commandReceipt?.let { base["receipt"] = receiptBody(it) }
    event.threadReceipt?.let { base["receipt"] = threadReceiptBody(it) }
    event.realtimeTerminalSummary?.let { base["summary"] = realtimeTerminalSummaryBody(it) }
    event.draftArtifact?.let { base["artifact"] = draftHandleBody(it) }
    event.presentationAction?.let { base["action"] = presentationActionBody(it) }
    event.presentationElection?.let { election ->
      base["election"] = mapOf(
        "electedLeaseId" to election.electedLeaseId,
        "electedAttachOrdinal" to election.electedAttachOrdinal?.toDouble(),
        "eligibleConsumerCount" to election.eligibleConsumerCount.toDouble(),
        "changedAt" to iso(election.changedAtEpochMillis),
      )
    }
    return base
  }

  fun draftBody(artifact: VoiceRuntimeStoredDraft): Map<String, Any?> = mapOf(
    "handle" to draftHandleBody(artifact.handle),
    "transcript" to artifact.transcript,
  )

  fun threadReceiptBody(receipt: VoiceRuntimeThreadReceipt): Map<String, Any?> = mapOf(
    "runtimeId" to receipt.identity.runtimeId,
    "runtimeInstanceId" to receipt.identity.runtimeInstanceId,
    "runtimeGeneration" to receipt.identity.generation.toDouble(),
    "modeSessionId" to receipt.modeSessionId,
    "turnClientOperationId" to receipt.turnClientOperationId,
    "turnOperationId" to receipt.turnOperationId,
    "target" to mapOf(
      "environmentId" to receipt.environmentId,
      "projectId" to receipt.projectId,
      "threadId" to receipt.threadId,
    ),
    "userMessageId" to receipt.userMessageId,
    "turnId" to receipt.turnId,
    "assistantMessageIds" to receipt.assistantMessageIds,
    "speechPlanId" to receipt.speechPlanId,
    "highestAdvertisedSegment" to receipt.highestAdvertisedSegment?.toDouble(),
    "highestStartedSegment" to receipt.highestStartedSegment?.toDouble(),
    "highestDrainedSegment" to receipt.highestDrainedSegment?.toDouble(),
    "segmentDispositions" to receipt.segmentDispositions.map {
      mapOf("segmentIndex" to it.segmentIndex.toDouble(), "disposition" to it.disposition)
    },
    "speechTerminal" to receipt.speechTerminal,
    "terminalOutcome" to receipt.terminalOutcome,
    "createdAt" to iso(receipt.createdAtEpochMillis),
    "expiresAt" to iso(receipt.expiresAtEpochMillis),
  )

  fun realtimeTerminalSummaryBody(
    summary: VoiceRuntimeRealtimeTerminalSummary,
  ): Map<String, Any?> = mapOf(
    "runtimeId" to summary.identity.runtimeId,
    "runtimeInstanceId" to summary.identity.runtimeInstanceId,
    "runtimeGeneration" to summary.identity.generation.toDouble(),
    "modeSessionId" to summary.modeSessionId,
    "conversationId" to summary.conversationId,
    "sessionId" to summary.sessionId,
    "outcome" to summary.outcome.name.lowercase(),
    "reason" to summary.reason,
    "lastConnectedAt" to summary.lastConnectedAtEpochMillis?.let(::iso),
    "terminalAt" to iso(summary.terminalAtEpochMillis),
    "serverCleanupPending" to summary.serverCleanupPending,
    "expiresAt" to iso(summary.expiresAtEpochMillis),
  )

  fun draftHandleBody(handle: VoiceRuntimeDraftHandle): Map<String, Any?> = mapOf(
    "artifactId" to handle.artifactId,
    "runtimeId" to handle.identity.runtimeId,
    "runtimeInstanceId" to handle.identity.runtimeInstanceId,
    "runtimeGeneration" to handle.identity.generation.toDouble(),
    "modeSessionId" to handle.modeSessionId,
    "turnClientOperationId" to handle.turnClientOperationId,
    "target" to mapOf(
      "environmentId" to handle.target.environmentId,
      "projectId" to handle.target.projectId,
      "threadId" to handle.target.threadId,
    ),
    "composerRevision" to handle.target.composerRevision,
    "expiresAt" to iso(handle.expiresAtEpochMillis),
  )

  fun presentationActionBody(action: VoiceRuntimePresentationAction): Map<String, Any?> =
    when (action) {
      is VoiceRuntimePresentationAction.NavigateThread -> mapOf(
        "actionId" to action.actionId,
        "action" to "navigate-thread",
        "projectId" to action.projectId,
        "threadId" to action.threadId,
        "expiresAt" to iso(action.expiresAtEpochMillis),
      )
      is VoiceRuntimePresentationAction.ReviewDraft -> mapOf(
        "actionId" to action.actionId,
        "action" to "review-draft",
        "artifact" to draftHandleBody(action.artifact),
        "expiresAt" to iso(action.expiresAtEpochMillis),
      )
      is VoiceRuntimePresentationAction.RealtimeConfirmationRequired -> mapOf(
        "actionId" to action.actionId,
        "action" to "realtime-confirmation-required",
        "confirmationId" to action.confirmationId,
        "toolCallId" to action.toolCallId,
        "tool" to action.tool,
        "summary" to action.summary,
        "expiresAt" to iso(action.expiresAtEpochMillis),
      )
    }

  fun parseRetainedRecordKey(input: Map<String, Any?>): VoiceRuntimeRetainedRecordKey =
    when (text(input, "kind")) {
      "thread-receipt" -> {
        requireKeys(input, setOf(
          "kind", "sourceRuntimeId", "sourceRuntimeInstanceId", "sourceRuntimeGeneration",
          "modeSessionId", "turnClientOperationId",
        ))
        val sourceGeneration = long(input, "sourceRuntimeGeneration").also { require(it > 0) }
        VoiceRuntimeRetainedRecordKey.ThreadReceipt(
          VoiceRuntimeIdentity(
            text(input, "sourceRuntimeId"),
            text(input, "sourceRuntimeInstanceId"),
            sourceGeneration,
          ),
          text(input, "modeSessionId"),
          text(input, "turnClientOperationId"),
        )
      }
      "realtime-terminal" -> {
        requireKeys(input, setOf(
          "kind", "sourceRuntimeId", "sourceRuntimeInstanceId", "sourceRuntimeGeneration",
          "modeSessionId",
        ))
        val sourceGeneration = long(input, "sourceRuntimeGeneration").also { require(it > 0) }
        VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
          VoiceRuntimeIdentity(
            text(input, "sourceRuntimeId"),
            text(input, "sourceRuntimeInstanceId"),
            sourceGeneration,
          ),
          text(input, "modeSessionId"),
        )
      }
      else -> throw IllegalArgumentException("Unsupported retained voice record kind.")
    }

  fun parseRetainedRecordAcknowledgement(
    input: Map<String, Any?>,
  ): Pair<VoiceRuntimeIdentity, VoiceRuntimeRetainedRecordKey> {
    requireKeys(input, setOf(
      "runtimeId", "runtimeInstanceId", "authorityGeneration", "record",
    ))
    val record = objectValue(input, "record")
    val authorityGeneration = long(input, "authorityGeneration").also { require(it > 0) }
    return VoiceRuntimeIdentity(
      text(input, "runtimeId"),
      text(input, "runtimeInstanceId"),
      authorityGeneration,
    ) to parseRetainedRecordKey(record)
  }

  private fun outcomeBody(outcome: VoiceRuntimeCommandOutcome): Map<String, Any?> = when (outcome) {
    VoiceRuntimeCommandOutcome.Accepted -> mapOf("type" to "accepted")
    is VoiceRuntimeCommandOutcome.Rejected -> mapOf("type" to "rejected", "reason" to outcome.reason)
    is VoiceRuntimeCommandOutcome.RebaseRequired -> mapOf(
      "type" to "rebase-required",
      "rebase" to deliveryBody(outcome.rebase),
    )
  }

  fun targetBody(target: VoiceRuntimeTarget): Map<String, Any?> = when (target) {
    is VoiceRuntimeTarget.Realtime -> mapOf(
      "mode" to "realtime",
      "environmentId" to target.environmentId,
      "conversationId" to target.conversationId,
    )
    is VoiceRuntimeTarget.Thread -> mapOf(
      "mode" to "thread",
      "environmentId" to target.environmentId,
      "projectId" to target.projectId,
      "threadId" to target.threadId,
      "speechPreset" to target.speechPreset,
      "autoRearm" to target.autoRearm,
      "endpointPolicy" to mapOf(
        "endSilenceMs" to target.endSilenceMs.toDouble(),
        "noSpeechTimeoutMs" to target.noSpeechTimeoutMs?.toDouble(),
        "maximumUtteranceMs" to target.maximumUtteranceMs.toDouble(),
      ),
      "speechEnabled" to target.speechEnabled,
      "rearmGuardMs" to target.rearmGuardMs.toDouble(),
    )
  }

  private fun operationBody(operation: VoiceRuntimeOperation): Map<String, Any?> = when (operation) {
    VoiceRuntimeOperation.None -> mapOf("kind" to "none")
    is VoiceRuntimeOperation.Realtime -> mapOf(
      "kind" to "realtime",
      "modeSessionId" to operation.modeSessionId,
      "phase" to operation.phase.name.lowercase().replace('_', '-'),
      "conversationId" to operation.conversationId,
      "sessionId" to operation.sessionId,
      "muted" to operation.muted,
    )
    is VoiceRuntimeOperation.ThreadTurn -> mapOf(
      "kind" to "thread-turn",
      "modeSessionId" to operation.modeSessionId,
      "phase" to threadPhaseBody(operation.phase),
      "turnClientOperationId" to operation.turnClientOperationId,
      "turnOperationId" to operation.turnOperationId,
    )
  }

  private fun threadPhaseBody(phase: VoiceThreadPhase): Map<String, String> = when (phase) {
    is VoiceThreadPhase.Ordinary -> mapOf(
      "phase" to phase.phase.name.lowercase().replace('_', '-'),
    )
    is VoiceThreadPhase.Paused -> mapOf(
      "phase" to "paused",
      "reason" to phase.reason.name.lowercase().replace('_', '-'),
    )
    is VoiceThreadPhase.AttentionRequired -> mapOf(
      "phase" to "attention-required",
      "reason" to phase.reason.name.lowercase().replace('_', '-'),
    )
  }

  private fun mediaBody(
    media: VoiceRuntimeMediaOwner,
    operation: VoiceRuntimeOperation,
  ): Map<String, Any?> {
    val root = (operation as? VoiceRuntimeOperation.ThreadTurn)?.let {
      mapOf(
        "kind" to "turn",
        "modeSessionId" to it.modeSessionId,
        "turnClientOperationId" to it.turnClientOperationId,
        "turnOperationId" to it.turnOperationId,
      )
    } ?: mapOf("kind" to "none")
    return when (media) {
      VoiceRuntimeMediaOwner.None -> mapOf("kind" to "none")
      is VoiceRuntimeMediaOwner.Recorder -> mapOf(
        "kind" to "recorder", "owner" to media.owner, "root" to root,
      )
      is VoiceRuntimeMediaOwner.Player -> mapOf(
        "kind" to "player", "owner" to media.owner, "root" to root,
      )
      is VoiceRuntimeMediaOwner.RealtimePeer -> mapOf(
        "kind" to "realtime-peer", "modeSessionId" to media.modeSessionId,
      )
      is VoiceRuntimeMediaOwner.Cue -> mapOf("kind" to "cue-player", "root" to root)
    }
  }

  private fun readinessBody(readiness: VoiceRuntimeReadiness): Map<String, Any> = when (readiness) {
    VoiceRuntimeReadiness.Disabled -> mapOf("state" to "disabled")
    is VoiceRuntimeReadiness.Ready -> mapOf("state" to "ready", "mode" to readiness.mode.name.lowercase())
    is VoiceRuntimeReadiness.Active -> mapOf("state" to "active", "mode" to readiness.mode.name.lowercase())
  }

  private fun cursorBody(cursor: VoiceRuntimeCursor): Map<String, Any> = mapOf(
    "runtimeId" to cursor.runtimeId,
    "runtimeInstanceId" to cursor.runtimeInstanceId,
    "generation" to cursor.generation.toDouble(),
    "sequence" to cursor.sequence.toDouble(),
  )

  private fun presentationWire(value: VoiceRuntimePresentation): String = when (value) {
    VoiceRuntimePresentation.FOREGROUND_ACTIVE -> "foreground-active"
    VoiceRuntimePresentation.VISIBLE_INACTIVE -> "visible-inactive"
    VoiceRuntimePresentation.BACKGROUND -> "background"
  }

  private fun iso(epochMillis: Long): String = Instant.ofEpochMilli(epochMillis).toString()

  private fun requireKeys(input: Map<String, Any?>, keys: Set<String>) {
    require(input.keys == keys) { "Voice runtime object fields do not match the contract." }
  }

  private fun text(input: Map<String, Any?>, key: String): String =
    (input[key] as? String)?.takeIf { it.isNotBlank() }
      ?: throw IllegalArgumentException("$key must be non-empty text.")

  private fun long(input: Map<String, Any?>, key: String): Long =
    (input[key] as? Number)?.toLong()
      ?: throw IllegalArgumentException("$key must be a number.")

  private fun nullableLong(input: Map<String, Any?>, key: String): Long? =
    input[key]?.let { (it as? Number)?.toLong() ?: error("$key must be a number or null.") }

  private fun boolean(input: Map<String, Any?>, key: String): Boolean =
    input[key] as? Boolean ?: throw IllegalArgumentException("$key must be a boolean.")

  @Suppress("UNCHECKED_CAST")
  private fun objectValue(input: Map<String, Any?>, key: String): Map<String, Any?> =
    input[key] as? Map<String, Any?>
      ?: throw IllegalArgumentException("$key must be an object.")
}
