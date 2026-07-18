package expo.modules.t3voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.MediaRecorder
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.JavaAudioDeviceModule

internal interface T3VoiceWebRtcResultCallback<T> {
  fun onSuccess(result: T)

  fun onFailure(code: String, message: String, cause: Throwable? = null)
}

internal interface T3VoiceRealtimeMedia {
  /** Lightweight exact cancellation; never closes or disposes JNI peer resources. */
  fun cancelStartup(sessionId: String)

  fun prepare(
    sessionId: String,
    diagnosticGeneration: Long,
    callback: T3VoiceWebRtcResultCallback<String>,
  )

  fun applyAnswer(
    sessionId: String,
    answerSdp: String,
    callback: T3VoiceWebRtcResultCallback<Unit>,
  )

  fun stop(sessionId: String): Boolean

  fun fenceInputAndDrainPlayout(
    sessionId: String,
    onComplete: () -> Unit,
  )

  fun setMuted(sessionId: String, muted: Boolean)

  /** Arm microphone after Ready cue (or immediately when cues disabled). */
  fun setInputReady(sessionId: String, ready: Boolean)
}

private enum class T3VoiceRealtimePlayoutDrainOutcome {
  DRAINED,
  TIMED_OUT,
  SESSION_ENDED,
}

internal class T3VoiceWebRtcSession(
  context: Context,
  private val onStateChanged: (String, String, Boolean) -> Unit,
  private val onError: (String, String, String, Boolean) -> Unit,
  private val onTerminated: (String, String, String, Boolean) -> Unit,
  sharedAudioRouter: T3VoiceAudioRouter? = null,
) : T3VoiceRealtimeMedia {
  private data class ActiveSession(
    val sessionId: String,
    val diagnosticGeneration: Long,
    val audioOwner: T3VoiceRealtimeAudioOwnerPolicy.Owner,
    val playoutMonitor: T3VoiceRealtimePlayoutMonitor,
    val audioDeviceModule: JavaAudioDeviceModule,
    val peerConnectionFactory: PeerConnectionFactory,
    val timeoutOwner: T3VoiceRealtimeConnectionTimeoutPolicy.Owner,
    val peerConnection: PeerConnection,
    val audioSource: AudioSource,
    val audioTrack: AudioTrack,
    val dataChannel: DataChannel,
    var captureState: T3VoiceCaptureState = T3VoiceCaptureState(),
    var localDescriptionSet: Boolean = false,
    var iceGatheringComplete: Boolean = false,
    var offerDelivered: Boolean = false,
    var answerApplied: Boolean = false,
    var offerCallback: T3VoiceWebRtcResultCallback<String>? = null,
    var answerCallback: T3VoiceWebRtcResultCallback<Unit>? = null,
    var offerTimeout: ScheduledFuture<*>? = null,
    var connectingTimeout: ScheduledFuture<*>? = null,
    var disconnectedTimeout: ScheduledFuture<*>? = null,
    var audioRouterGeneration: Long? = null,
    var playoutDrain: PlayoutDrain? = null,
    val resourcesReleased: AtomicBoolean = AtomicBoolean(false),
  )

  private data class PlayoutDrain(
    val onComplete: () -> Unit,
    val policy: T3VoiceRealtimePlayoutDrainPolicy,
    var sample: ScheduledFuture<*>? = null,
    var timeout: ScheduledFuture<*>? = null,
  )

  private data class PreparedPeer(
    val audioDeviceModule: JavaAudioDeviceModule,
    val peerConnectionFactory: PeerConnectionFactory,
    val audioSource: AudioSource,
    val audioTrack: AudioTrack,
    val peerConnection: PeerConnection,
    val dataChannel: DataChannel,
    val playoutMonitor: T3VoiceRealtimePlayoutMonitor,
  )

  private val applicationContext = context.applicationContext
  private val lock = Any()
  private val scheduler = Executors.newSingleThreadScheduledExecutor()
  private val audioRouter =
    sharedAudioRouter ?: T3VoiceAudioRouter(
      applicationContext,
      ::handleAudioFocusActions,
    )
  private val terminalLatch = T3VoiceRealtimeTerminalLatch()
  private val audioOwners = T3VoiceRealtimeAudioOwnerPolicy()
  private val connectionTimeouts = T3VoiceRealtimeConnectionTimeoutPolicy()
  private val prepareFence = T3VoiceRealtimePrepareFence()
  private var active: ActiveSession? = null
  private val usedSessionIds = T3VoiceSessionIdTombstones(SESSION_ID_TOMBSTONE_CAPACITY)

  init {
    initializeWebRtc(applicationContext)
  }

  private fun createPeerResources(
    sessionId: String,
    audioOwner: T3VoiceRealtimeAudioOwnerPolicy.Owner,
  ): PreparedPeer {
    var audioDeviceModule: JavaAudioDeviceModule? = null
    var peerConnectionFactory: PeerConnectionFactory? = null
    var audioSource: AudioSource? = null
    var audioTrack: AudioTrack? = null
    var peerConnection: PeerConnection? = null
    var dataChannel: DataChannel? = null
    val playoutMonitor = T3VoiceRealtimePlayoutMonitor()
    try {
      audioDeviceModule =
        JavaAudioDeviceModule.builder(applicationContext)
          .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build(),
          )
          .setUseHardwareAcousticEchoCanceler(
            JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported(),
          )
          .setUseHardwareNoiseSuppressor(
            JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported(),
          )
          .setAudioRecordErrorCallback(AudioRecordErrorCallback(audioOwner))
          .setAudioTrackErrorCallback(AudioTrackErrorCallback(audioOwner))
          .setPlaybackSamplesReadyCallback(PlaybackSamplesReadyCallback(playoutMonitor))
          .createAudioDeviceModule()
      peerConnectionFactory =
        PeerConnectionFactory.builder()
          .setAudioDeviceModule(audioDeviceModule)
          .createPeerConnectionFactory()
      audioSource = peerConnectionFactory.createAudioSource(audioConstraints())
      audioTrack = peerConnectionFactory.createAudioTrack(LOCAL_AUDIO_TRACK_ID, audioSource)
      audioTrack.setEnabled(true)
      check(audioTrack.enabled()) { "WebRTC could not enable the microphone track." }
      peerConnection =
        peerConnectionFactory.createPeerConnection(
          rtcConfiguration(),
          PeerObserver(sessionId),
        ) ?: error("WebRTC could not create a peer connection.")
      check(peerConnection.addTrack(audioTrack, listOf(LOCAL_MEDIA_STREAM_ID)) != null) {
        "WebRTC could not attach the microphone track."
      }
      peerConnection.setAudioPlayout(true)
      peerConnection.setAudioRecording(true)
      dataChannel =
        peerConnection.createDataChannel(
          DATA_CHANNEL_LABEL,
          DataChannel.Init().apply { ordered = true },
        )
      dataChannel.registerObserver(DataChannelObserver(sessionId, dataChannel))
      return PreparedPeer(
        audioDeviceModule,
        peerConnectionFactory,
        audioSource,
        audioTrack,
        peerConnection,
        dataChannel,
        playoutMonitor,
      )
    } catch (cause: Throwable) {
      releasePeerResources(
        audioDeviceModule,
        peerConnectionFactory,
        audioSource,
        audioTrack,
        peerConnection,
        dataChannel,
      )
      throw cause
    }
  }

  override fun prepare(
    sessionId: String,
    diagnosticGeneration: Long,
    callback: T3VoiceWebRtcResultCallback<String>,
  ) {
    require(sessionId.isNotBlank()) { "nativeSessionId must be a non-empty string." }
    val (attempt, audioOwner) = synchronized(lock) {
      check(active == null) { "A Realtime voice session is already active." }
      check(usedSessionIds.add(sessionId)) { "Realtime native session IDs cannot be reused." }
      val admitted = prepareFence.begin(sessionId) ?: return
      admitted to audioOwners.issue(sessionId)
    }
    val prepared =
      try {
        createPeerResources(sessionId, audioOwner)
      } catch (cause: Throwable) {
        prepareFence.abandon(attempt)
        throw cause
      }
    val audioSource = prepared.audioSource
    val audioTrack = prepared.audioTrack
    val peerConnection = prepared.peerConnection
    val dataChannel = prepared.dataChannel
    var installedSession: ActiveSession? = null
    val session =
      try {
        synchronized(lock) {
          if (!prepareFence.claimInstall(attempt)) return@synchronized null
          check(active == null) { "A Realtime voice session started concurrently." }
          ActiveSession(
            sessionId = sessionId,
            diagnosticGeneration = diagnosticGeneration,
            audioOwner = audioOwner,
            playoutMonitor = prepared.playoutMonitor,
            audioDeviceModule = prepared.audioDeviceModule,
            peerConnectionFactory = prepared.peerConnectionFactory,
            timeoutOwner = connectionTimeouts.activate(sessionId),
            peerConnection = peerConnection,
            audioSource = audioSource,
            audioTrack = audioTrack,
            dataChannel = dataChannel,
            offerCallback = callback,
          ).also { session ->
            active = session
            audioOwners.activate(audioOwner)
            installedSession = session
            // Gate mic until Ready arming sets inputReady (default false).
            applyCaptureState(session)
            terminalLatch.activate(sessionId)
            session.offerTimeout =
              scheduler.schedule(
                { fail(sessionId, ERROR_ICE_TIMEOUT, "WebRTC ICE gathering timed out.", null, true) },
                ICE_GATHERING_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
              )
          }
        }
      } catch (cause: Throwable) {
        prepareFence.abandon(attempt)
        val installed = installedSession
        if (installed == null) {
          releasePreparedPeer(prepared)
        } else {
          synchronized(lock) {
            if (active === installed) active = null
          }
          releaseSession(installed)
          terminalLatch.claim(installed.sessionId)
        }
        throw cause
      }
    if (session == null) {
      releasePreparedPeer(prepared)
      return
    }
    if (releaseCancelledPreparation(attempt, session)) return
    try {
      val routerStart = audioRouter.startCommunication()
      if (releaseCancelledPreparation(attempt, session)) return
      check(routerStart.transition.state != T3VoiceAudioFocusState.TERMINATED) {
        "Android denied Realtime audio focus."
      }
      synchronized(lock) {
        active?.takeIf { it === session }?.audioRouterGeneration = routerStart.ownerGeneration
      }
      onStateChanged(sessionId, STATE_PREPARING, false)
      if (releaseCancelledPreparation(attempt, session)) return
      peerConnection.createOffer(OfferObserver(sessionId), offerConstraints())
      if (releaseCancelledPreparation(attempt, session)) return
    } catch (cause: Throwable) {
      prepareFence.abandon(attempt)
      fail(
        sessionId,
        ERROR_PREPARE_FAILED,
        cause.message ?: "Could not prepare the Realtime peer.",
        cause,
        false,
      )
      return
    }
    val retained =
      synchronized(lock) {
        val live = prepareFence.complete(attempt)
        if (!live && active === session) active = null
        live
      }
    if (!retained) {
      releaseSession(session)
      terminalLatch.claim(sessionId)
      audioRouter.stop()
      return
    }
  }

  private fun releaseCancelledPreparation(
    attempt: T3VoiceRealtimePrepareFence.Attempt,
    session: ActiveSession,
  ): Boolean {
    val cancelled =
      synchronized(lock) {
        if (prepareFence.isLive(attempt)) return@synchronized false
        prepareFence.abandon(attempt)
        if (active === session) active = null
        true
      }
    if (!cancelled) return false
    releaseSession(session)
    terminalLatch.claim(session.sessionId)
    audioRouter.stop()
    return true
  }

  override fun cancelStartup(sessionId: String) {
    require(sessionId.isNotBlank()) { "nativeSessionId must be a non-empty string." }
    synchronized(lock) {
      val current = active
      if (current != null) {
        check(current.sessionId == sessionId) {
          "Realtime session $sessionId does not own the active peer."
        }
      }
      prepareFence.cancelStartup(sessionId)
    }
  }

  override fun applyAnswer(
    sessionId: String,
    answerSdp: String,
    callback: T3VoiceWebRtcResultCallback<Unit>,
  ) {
    require(answerSdp.isNotBlank()) { "sdp must be a non-empty string." }
    val peer =
      synchronized(lock) {
        val session = requireActive(sessionId)
        check(session.offerDelivered) { "The local WebRTC offer is not ready." }
        check(!session.answerApplied) { "A WebRTC answer was already applied." }
        check(session.answerCallback == null) { "A WebRTC answer is already being applied." }
        session.answerCallback = callback
        armConnectionTimeout(session)
        session.peerConnection
      }
    onStateChanged(sessionId, STATE_CONNECTING, isMuted(sessionId))
    try {
      peer.setRemoteDescription(
        object : BaseSdpObserver() {
          override fun onSetSuccess() {
            val acceptedCallback =
              synchronized(lock) {
                val session = active
                if (session?.sessionId != sessionId || session.answerApplied) {
                  null
                } else {
                  session.answerApplied = true
                  session.answerCallback.also { session.answerCallback = null }
                }
              }
            acceptedCallback?.onSuccess(Unit)
          }

          override fun onSetFailure(message: String?) {
            val detail = message ?: "WebRTC rejected the remote answer."
            val failedCallback =
              synchronized(lock) {
                active?.takeIf { it.sessionId == sessionId }?.let { session ->
                  session.answerCallback.also { session.answerCallback = null }
                }
              }
            failedCallback?.onFailure(ERROR_ANSWER_REJECTED, detail)
            fail(sessionId, ERROR_ANSWER_REJECTED, detail, null, false)
          }
        },
        SessionDescription(SessionDescription.Type.ANSWER, answerSdp),
      )
    } catch (cause: Throwable) {
      synchronized(lock) {
        active?.takeIf { it.sessionId == sessionId }?.answerCallback = null
      }
      callback.onFailure(
        ERROR_ANSWER_REJECTED,
        cause.message ?: "WebRTC rejected the remote answer.",
        cause,
      )
      fail(
        sessionId,
        ERROR_ANSWER_REJECTED,
        cause.message ?: "WebRTC rejected the remote answer.",
        cause,
        false,
      )
    }
  }

  override fun setMuted(sessionId: String, muted: Boolean) {
    val update =
      synchronized(lock) {
        val session = requireActive(sessionId)
        session.captureState = T3VoiceCapturePolicy.setUserMuted(session.captureState, muted)
        applyCaptureState(session)
        connectionStateFor(session) to effectiveMuted(session)
      }
    onStateChanged(sessionId, update.first, update.second)
  }

  override fun setInputReady(sessionId: String, ready: Boolean) {
    val update =
      synchronized(lock) {
        val session = requireActive(sessionId)
        session.captureState = T3VoiceCapturePolicy.setInputReady(session.captureState, ready)
        applyCaptureState(session)
        connectionStateFor(session) to effectiveMuted(session)
      }
    onStateChanged(sessionId, update.first, update.second)
  }

  override fun fenceInputAndDrainPlayout(
    sessionId: String,
    onComplete: () -> Unit,
  ) {
    val session =
      synchronized(lock) {
        val current = requireActive(sessionId)
        check(current.playoutDrain == null) { "Realtime playout is already draining." }
        current.captureState = T3VoiceCapturePolicy.fenceTerminalInput(current.captureState)
        applyCaptureState(current)
        current.playoutMonitor.arm()
        val drain =
          PlayoutDrain(
            onComplete = onComplete,
            policy = T3VoiceRealtimePlayoutDrainPolicy(monotonicMillis()),
          )
        current.playoutDrain = drain
        drain.timeout =
          scheduler.schedule(
            { completePlayoutDrain(current, T3VoiceRealtimePlayoutDrainOutcome.TIMED_OUT) },
            T3VoiceRealtimePlayoutDrainPolicy.MAXIMUM_MILLIS,
            TimeUnit.MILLISECONDS,
          )
        current
      }
    samplePlayoutDrain(session)
  }

  override fun stop(sessionId: String): Boolean {
    val (session, cancelledPreparation) =
      synchronized(lock) {
        val cancelled =
          prepareFence.cancelPending(sessionId) ||
            prepareFence.retireCancelledBeforeBegin(sessionId)
        val current = active ?: return@synchronized null to cancelled
        check(current.sessionId == sessionId) {
          "Realtime session $sessionId does not own the active peer."
        }
        active = null
        current to cancelled
      }
    if (session == null) {
      if (cancelledPreparation) audioRouter.stop()
      return cancelledPreparation
    }
    session.offerCallback?.onFailure(
      ERROR_SESSION_STOPPED,
      "The Realtime session stopped before signaling completed.",
    )
    session.offerCallback = null
    session.answerCallback?.onFailure(
      ERROR_SESSION_STOPPED,
      "The Realtime session stopped before signaling completed.",
    )
    session.answerCallback = null
    releaseSession(session)
    audioRouter.stop()
    if (terminalLatch.claim(sessionId)) {
      T3VoiceDiagnostics.record(
        session.diagnosticGeneration,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.ENDED,
      )
      onTerminated(
        sessionId,
        OUTCOME_ENDED,
        ERROR_SESSION_STOPPED,
        false,
      )
    }
    onStateChanged(sessionId, STATE_CLOSED, effectiveMuted(session))
    return true
  }

  fun release() {
    val session =
      synchronized(lock) {
        prepareFence.cancelPending()
        active?.also { active = null }
      }
    if (session != null) {
      session.offerCallback?.onFailure(
        ERROR_SESSION_STOPPED,
        "The Realtime session stopped before signaling completed.",
      )
      session.answerCallback?.onFailure(
        ERROR_SESSION_STOPPED,
        "The Realtime session stopped before signaling completed.",
      )
      releaseSession(session)
    }
    audioRouter.stop()
    scheduler.shutdownNow()
  }

  private fun maybeDeliverOffer(sessionId: String) {
    val result =
      synchronized(lock) {
        val session = active
        if (
          session?.sessionId != sessionId ||
            !session.localDescriptionSet ||
            !session.iceGatheringComplete ||
            session.offerDelivered
        ) {
          null
        } else {
          val description = session.peerConnection.localDescription?.description
          if (description.isNullOrBlank()) {
            null
          } else {
            session.offerDelivered = true
            session.offerTimeout?.cancel(false)
            session.offerTimeout = null
            val callback = session.offerCallback
            session.offerCallback = null
            Triple(callback, description, effectiveMuted(session))
          }
        }
      }
    if (result != null) {
      onStateChanged(sessionId, STATE_OFFER_READY, result.third)
      result.first?.onSuccess(result.second)
    }
  }

  private fun updateConnectionState(sessionId: String, state: PeerConnection.PeerConnectionState) {
    val normalized =
      when (state) {
        PeerConnection.PeerConnectionState.NEW -> STATE_PREPARING
        PeerConnection.PeerConnectionState.CONNECTING -> STATE_CONNECTING
        PeerConnection.PeerConnectionState.CONNECTED -> STATE_CONNECTED
        PeerConnection.PeerConnectionState.DISCONNECTED -> STATE_DISCONNECTED
        PeerConnection.PeerConnectionState.FAILED -> STATE_FAILED
        PeerConnection.PeerConnectionState.CLOSED -> STATE_CLOSED
    }
    if (state == PeerConnection.PeerConnectionState.FAILED) {
      fail(
        sessionId,
        ERROR_CONNECTION_FAILED,
        "The Realtime media connection failed.",
        null,
        true,
      )
      return
    }
    if (state == PeerConnection.PeerConnectionState.CLOSED) {
      fail(
        sessionId,
        ERROR_CONNECTION_CLOSED,
        "The Realtime media connection closed unexpectedly.",
        null,
        true,
      )
      return
    }
    val stateUpdate =
      synchronized(lock) {
        val session = active?.takeIf { it.sessionId == sessionId } ?: return
        when (state) {
          PeerConnection.PeerConnectionState.CONNECTED -> cancelConnectionTimeouts(session)
          PeerConnection.PeerConnectionState.DISCONNECTED -> armDisconnectedTimeout(session)
          else -> Unit
        }
        effectiveMuted(session) to session.diagnosticGeneration
      }
    if (state == PeerConnection.PeerConnectionState.CONNECTED) {
      T3VoiceDiagnostics.record(
        stateUpdate.second,
        T3VoiceDiagnosticCategory.STATE,
        T3VoiceDiagnosticCode.ACTIVE,
      )
    }
    onStateChanged(sessionId, normalized, stateUpdate.first)
  }

  internal fun handleAudioFocusActions(actions: List<T3VoiceAudioFocusAction>) {
    val session = synchronized(lock) { active } ?: return
    for (action in actions) {
      if (synchronized(lock) { active !== session }) return
      val applied =
        runCatching {
          when (action) {
            T3VoiceAudioFocusAction.MUTE_CAPTURE -> {
              synchronized(lock) {
                check(active === session) { "Realtime session changed during audio focus loss." }
                session.captureState =
                  T3VoiceCapturePolicy.setFocusSuspended(session.captureState, suspended = true)
                applyCaptureState(session)
              }
            }
            T3VoiceAudioFocusAction.PAUSE_PLAYBACK -> session.peerConnection.setAudioPlayout(false)
            T3VoiceAudioFocusAction.UNMUTE_CAPTURE -> {
              synchronized(lock) {
                check(active === session) { "Realtime session changed during audio focus gain." }
                session.captureState =
                  T3VoiceCapturePolicy.setFocusSuspended(session.captureState, suspended = false)
                applyCaptureState(session)
              }
            }
            T3VoiceAudioFocusAction.RESUME_PLAYBACK -> session.peerConnection.setAudioPlayout(true)
            T3VoiceAudioFocusAction.TERMINATE_SESSION ->
              fail(
                session.sessionId,
                ERROR_AUDIO_FOCUS_LOST,
                "Realtime audio focus was lost.",
                null,
                true,
              )
          }
        }
      if (applied.isFailure) {
        fail(
          session.sessionId,
          ERROR_AUDIO_FOCUS_FAILED,
          "Realtime audio focus transition failed.",
          applied.exceptionOrNull(),
          true,
        )
        return
      }
    }
    if (synchronized(lock) { active === session }) {
      val focusMuted = T3VoiceAudioFocusAction.MUTE_CAPTURE in actions
      val focusResumed = T3VoiceAudioFocusAction.UNMUTE_CAPTURE in actions
      if (focusMuted || focusResumed) {
        val currentConnectionState = runCatching { connectionState(session.sessionId) }.getOrNull()
          ?: return
        onStateChanged(
          session.sessionId,
          currentConnectionState,
          synchronized(lock) {
            if (active !== session) return
            effectiveMuted(session)
          },
        )
      }
    }
  }

  private fun armConnectionTimeout(session: ActiveSession) {
    session.connectingTimeout?.cancel(false)
    val token =
      connectionTimeouts.arm(
        session.timeoutOwner,
        T3VoiceRealtimeConnectionTimeoutPolicy.Kind.CONNECTING,
      ) ?: return
    session.connectingTimeout =
      scheduler.schedule(
        {
          failOnConnectionTimeout(
            token,
            ERROR_CONNECTION_TIMEOUT,
            "The Realtime media connection timed out while connecting.",
          )
        },
        CONNECTION_TIMEOUT_SECONDS,
        TimeUnit.SECONDS,
      )
  }

  private fun armDisconnectedTimeout(session: ActiveSession) {
    session.disconnectedTimeout?.cancel(false)
    val token =
      connectionTimeouts.arm(
        session.timeoutOwner,
        T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED,
      ) ?: return
    session.disconnectedTimeout =
      scheduler.schedule(
        {
          failOnConnectionTimeout(
            token,
            ERROR_DISCONNECTED_TIMEOUT,
            "The Realtime media connection did not recover.",
          )
        },
        DISCONNECTED_GRACE_SECONDS,
        TimeUnit.SECONDS,
      )
  }

  private fun failOnConnectionTimeout(
    token: T3VoiceRealtimeConnectionTimeoutPolicy.Token,
    code: String,
    message: String,
  ) {
    val session =
      synchronized(lock) {
        if (!connectionTimeouts.consume(token)) return
        val current = active?.takeIf {
          it.sessionId == token.owner.sessionId && it.timeoutOwner == token.owner
        } ?: return
        val peerState = current.peerConnection.connectionState()
        val shouldFail =
          when (token.kind) {
            T3VoiceRealtimeConnectionTimeoutPolicy.Kind.CONNECTING ->
              peerState != PeerConnection.PeerConnectionState.CONNECTED
            T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED ->
              peerState != PeerConnection.PeerConnectionState.CONNECTED
          }
        if (!shouldFail) {
          if (peerState == PeerConnection.PeerConnectionState.CONNECTED) {
            cancelConnectionTimeouts(current)
          }
          return
        }
        active = null
        current
      }
    finishFailedSession(session, code, message, null, true)
  }

  private fun cancelConnectionTimeouts(session: ActiveSession) {
    session.connectingTimeout?.cancel(false)
    session.connectingTimeout = null
    session.disconnectedTimeout?.cancel(false)
    session.disconnectedTimeout = null
    connectionTimeouts.disarmAll(session.timeoutOwner)
  }

  private fun fail(
    sessionId: String,
    code: String,
    message: String,
    cause: Throwable?,
    recoverable: Boolean,
  ) {
    val session =
      synchronized(lock) {
        val current = active
        if (current?.sessionId != sessionId) return
        active = null
        current
      }
    finishFailedSession(session, code, message, cause, recoverable)
  }

  private fun finishFailedSession(
    session: ActiveSession,
    code: String,
    message: String,
    cause: Throwable?,
    recoverable: Boolean,
  ) {
    session.offerCallback?.onFailure(code, message, cause)
    session.offerCallback = null
    session.answerCallback?.onFailure(code, message, cause)
    session.answerCallback = null
    releaseSession(session)
    audioRouter.stop()
    if (terminalLatch.claim(session.sessionId)) {
      T3VoiceDiagnostics.record(
        session.diagnosticGeneration,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.FAILED,
      )
      onTerminated(
        session.sessionId,
        OUTCOME_FAILED,
        code,
        recoverable,
      )
    }
    onStateChanged(session.sessionId, STATE_FAILED, effectiveMuted(session))
  }

  private fun releaseSession(session: ActiveSession) {
    if (!session.resourcesReleased.compareAndSet(false, true)) return
    completePlayoutDrain(session, T3VoiceRealtimePlayoutDrainOutcome.SESSION_ENDED)
    session.offerTimeout?.cancel(false)
    session.offerTimeout = null
    cancelConnectionTimeouts(session)
    connectionTimeouts.deactivate(session.timeoutOwner)
    synchronized(lock) { audioOwners.deactivate(session.audioOwner) }
    releasePeerResources(
      session.audioDeviceModule,
      session.peerConnectionFactory,
      session.audioSource,
      session.audioTrack,
      session.peerConnection,
      session.dataChannel,
    )
  }

  private fun samplePlayoutDrain(session: ActiveSession) {
    val decision =
      synchronized(lock) {
        if (active !== session) return
        val drain = session.playoutDrain ?: return
        drain.policy.observe(monotonicMillis(), session.playoutMonitor.lastAudibleAtMillis())
      }
    when (decision) {
      T3VoiceRealtimePlayoutDrainDecision.DRAINED ->
        completePlayoutDrain(session, T3VoiceRealtimePlayoutDrainOutcome.DRAINED)
      T3VoiceRealtimePlayoutDrainDecision.TIMED_OUT ->
        completePlayoutDrain(session, T3VoiceRealtimePlayoutDrainOutcome.TIMED_OUT)
      T3VoiceRealtimePlayoutDrainDecision.WAIT ->
        synchronized(lock) {
          if (active === session) {
            session.playoutDrain?.sample =
              scheduler.schedule(
                { samplePlayoutDrain(session) },
                T3VoiceRealtimePlayoutDrainPolicy.SAMPLE_MILLIS,
                TimeUnit.MILLISECONDS,
              )
          }
        }
    }
  }

  private fun completePlayoutDrain(
    session: ActiveSession,
    outcome: T3VoiceRealtimePlayoutDrainOutcome,
  ) {
    val drain =
      synchronized(lock) {
        session.playoutDrain.also { session.playoutDrain = null }
      } ?: return
    drain.sample?.cancel(false)
    drain.timeout?.cancel(false)
    if (outcome == T3VoiceRealtimePlayoutDrainOutcome.TIMED_OUT) {
      T3VoiceDiagnostics.record(
        session.diagnosticGeneration,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.REALTIME_DRAIN_TIMED_OUT,
      )
    }
    session.playoutMonitor.disarm()
    runCatching(drain.onComplete)
  }

  private fun releasePreparedPeer(prepared: PreparedPeer) =
    releasePeerResources(
      prepared.audioDeviceModule,
      prepared.peerConnectionFactory,
      prepared.audioSource,
      prepared.audioTrack,
      prepared.peerConnection,
      prepared.dataChannel,
    )

  private fun releasePeerResources(
    audioDeviceModule: JavaAudioDeviceModule?,
    peerConnectionFactory: PeerConnectionFactory?,
    audioSource: AudioSource?,
    audioTrack: AudioTrack?,
    peerConnection: PeerConnection?,
    dataChannel: DataChannel?,
  ) {
    runCatching { dataChannel?.unregisterObserver() }
    runCatching { dataChannel?.close() }
    runCatching { dataChannel?.dispose() }
    runCatching { peerConnection?.close() }
    runCatching { peerConnection?.dispose() }
    runCatching { audioTrack?.dispose() }
    runCatching { audioSource?.dispose() }
    runCatching { peerConnectionFactory?.dispose() }
    runCatching { audioDeviceModule?.release() }
  }

  private fun requireActive(sessionId: String): ActiveSession {
    val session = active ?: error("No Realtime voice session is active.")
    check(session.sessionId == sessionId) {
      "Realtime session $sessionId does not own the active peer."
    }
    return session
  }

  private fun effectiveMuted(session: ActiveSession): Boolean =
    session.captureState.effectiveMuted

  private fun applyCaptureState(session: ActiveSession) {
    val muted = effectiveMuted(session)
    session.audioTrack.setEnabled(!muted)
    session.audioDeviceModule.setMicrophoneMute(muted)
    session.peerConnection.setAudioRecording(session.captureState.recordingEnabled)
    check(session.audioTrack.enabled() == !muted) { "WebRTC microphone state did not change." }
  }

  private fun isMuted(sessionId: String): Boolean =
    synchronized(lock) { effectiveMuted(requireActive(sessionId)) }

  private fun connectionState(sessionId: String): String {
    val session = synchronized(lock) { requireActive(sessionId) }
    return connectionStateFor(session)
  }

  private fun connectionStateFor(session: ActiveSession): String =
    when {
      session.peerConnection.connectionState() == PeerConnection.PeerConnectionState.CONNECTED ->
        STATE_CONNECTED
      session.answerApplied -> STATE_CONNECTING
      session.offerDelivered -> STATE_OFFER_READY
      else -> STATE_PREPARING
    }

  private inner class OfferObserver(private val sessionId: String) : BaseSdpObserver() {
    override fun onCreateSuccess(description: SessionDescription?) {
      if (description == null || description.description.isBlank()) {
        fail(sessionId, ERROR_OFFER_FAILED, "WebRTC created an empty SDP offer.", null, false)
        return
      }
      val peer = synchronized(lock) { active?.takeIf { it.sessionId == sessionId }?.peerConnection }
        ?: return
      peer.setLocalDescription(
        object : BaseSdpObserver() {
          override fun onSetSuccess() {
            synchronized(lock) {
              active?.takeIf { it.sessionId == sessionId }?.localDescriptionSet = true
            }
            maybeDeliverOffer(sessionId)
          }

          override fun onSetFailure(message: String?) {
            fail(
              sessionId,
              ERROR_OFFER_FAILED,
              message ?: "WebRTC rejected its local SDP offer.",
              null,
              false,
            )
          }
        },
        description,
      )
    }

    override fun onCreateFailure(message: String?) {
      fail(
        sessionId,
        ERROR_OFFER_FAILED,
        message ?: "WebRTC could not create an SDP offer.",
        null,
        false,
      )
    }
  }

  private inner class PeerObserver(private val sessionId: String) : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState?) {
      Unit
    }

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
      Unit
    }

    override fun onIceConnectionReceivingChange(receiving: Boolean) {
      Unit
    }

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
      if (state != PeerConnection.IceGatheringState.COMPLETE) return
      synchronized(lock) {
        active?.takeIf { it.sessionId == sessionId }?.iceGatheringComplete = true
      }
      maybeDeliverOffer(sessionId)
    }

    override fun onIceCandidate(candidate: IceCandidate?) = Unit

    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit

    override fun onAddStream(stream: MediaStream?) {
      stream?.audioTracks?.forEach { it.setEnabled(true) }
    }

    override fun onRemoveStream(stream: MediaStream?) = Unit

    override fun onDataChannel(channel: DataChannel?) {
      if (channel == null) return
      channel.close()
      channel.dispose()
    }

    override fun onRenegotiationNeeded() = Unit

    override fun onAddTrack(receiver: RtpReceiver?, mediaStreams: Array<out MediaStream>?) {
      receiver?.track()?.takeIf { it.kind() == "audio" }?.setEnabled(true)
    }

    override fun onTrack(transceiver: RtpTransceiver?) {
      transceiver?.receiver?.track()?.takeIf { it.kind() == "audio" }?.setEnabled(true)
    }

    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
      if (newState != null) updateConnectionState(sessionId, newState)
    }
  }

  private inner class DataChannelObserver(
    private val sessionId: String,
    private val channel: DataChannel,
  ) : DataChannel.Observer {
    override fun onBufferedAmountChange(previousAmount: Long) = Unit

    override fun onStateChange() {
      val state = channel.state()
      if (state == DataChannel.State.CLOSED) {
        val connected =
          synchronized(lock) {
            active?.takeIf { it.sessionId == sessionId }?.peerConnection?.connectionState() ==
              PeerConnection.PeerConnectionState.CONNECTED
          }
        if (connected) {
          onError(
            sessionId,
            ERROR_DATA_CHANNEL_CLOSED,
            "The Realtime event channel closed unexpectedly.",
            true,
          )
        }
      }
    }

    override fun onMessage(buffer: DataChannel.Buffer?) {
      if (buffer == null || buffer.binary) return
      val text = readUtf8(buffer.data)
      val isProviderError =
        runCatching { JSONObject(text).optString("type") == "error" }.getOrDefault(false)
      if (isProviderError) {
        onError(
          sessionId,
          ERROR_PROVIDER_EVENT,
          "The Realtime provider reported an error.",
          true,
        )
      }
    }
  }

  private inner class AudioRecordErrorCallback(
    private val owner: T3VoiceRealtimeAudioOwnerPolicy.Owner,
  ) : JavaAudioDeviceModule.AudioRecordErrorCallback {
    override fun onWebRtcAudioRecordInitError(message: String?) =
      reportAudioError(owner, "realtime-microphone-init", message)

    override fun onWebRtcAudioRecordStartError(
      code: JavaAudioDeviceModule.AudioRecordStartErrorCode?,
      message: String?,
    ) = reportAudioError(owner, "realtime-microphone-start", message)

    override fun onWebRtcAudioRecordError(message: String?) =
      reportAudioError(owner, "realtime-microphone", message)
  }

  private inner class AudioTrackErrorCallback(
    private val owner: T3VoiceRealtimeAudioOwnerPolicy.Owner,
  ) : JavaAudioDeviceModule.AudioTrackErrorCallback {
    override fun onWebRtcAudioTrackInitError(message: String?) =
      reportAudioError(owner, "realtime-playout-init", message)

    override fun onWebRtcAudioTrackStartError(
      code: JavaAudioDeviceModule.AudioTrackStartErrorCode?,
      message: String?,
    ) = reportAudioError(owner, "realtime-playout-start", message)

    override fun onWebRtcAudioTrackError(message: String?) =
      reportAudioError(owner, "realtime-playout", message)
  }

  private class PlaybackSamplesReadyCallback(
    private val monitor: T3VoiceRealtimePlayoutMonitor,
  ) : JavaAudioDeviceModule.PlaybackSamplesReadyCallback {
    override fun onWebRtcAudioTrackSamplesReady(samples: JavaAudioDeviceModule.AudioSamples) {
      if (samples.audioFormat != AudioFormat.ENCODING_PCM_16BIT) return
      monitor.observePcm16LittleEndian(samples.data, monotonicMillis())
    }
  }

  private fun reportAudioError(
    owner: T3VoiceRealtimeAudioOwnerPolicy.Owner,
    code: String,
    @Suppress("UNUSED_PARAMETER") providerMessage: String?,
  ) {
    val session =
      synchronized(lock) {
        if (!audioOwners.isActive(owner)) return
        val current = active?.takeIf { it.audioOwner == owner } ?: return
        active = null
        current
      }
    finishFailedSession(session, code, "Realtime audio failed.", null, true)
  }

  private open class BaseSdpObserver : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription?) = Unit

    override fun onSetSuccess() = Unit

    override fun onCreateFailure(message: String?) = Unit

    override fun onSetFailure(message: String?) = Unit
  }

  companion object {
    private const val LOCAL_AUDIO_TRACK_ID = "t3-audio"
    private const val LOCAL_MEDIA_STREAM_ID = "t3-media"
    private const val DATA_CHANNEL_LABEL = "oai-events"
    private const val ICE_GATHERING_TIMEOUT_SECONDS = 15L
    private const val CONNECTION_TIMEOUT_SECONDS = 20L
    private const val DISCONNECTED_GRACE_SECONDS = 10L
    private const val SESSION_ID_TOMBSTONE_CAPACITY = 256
    private const val STATE_PREPARING = "preparing"
    private const val STATE_OFFER_READY = "offer-ready"
    private const val STATE_CONNECTING = "connecting"
    private const val STATE_CONNECTED = "connected"
    private const val STATE_DISCONNECTED = "disconnected"
    private const val STATE_FAILED = "failed"
    private const val STATE_CLOSED = "closed"
    private const val OUTCOME_ENDED = "ended"
    private const val OUTCOME_FAILED = "failed"
    private const val ERROR_PREPARE_FAILED = "realtime-prepare-failed"
    private const val ERROR_OFFER_FAILED = "realtime-offer-failed"
    private const val ERROR_ICE_TIMEOUT = "realtime-ice-timeout"
    private const val ERROR_ANSWER_REJECTED = "realtime-answer-rejected"
    private const val ERROR_CONNECTION_FAILED = "realtime-connection-failed"
    private const val ERROR_CONNECTION_CLOSED = "realtime-connection-closed"
    private const val ERROR_AUDIO_FOCUS_LOST = "realtime-audio-focus-lost"
    private const val ERROR_AUDIO_FOCUS_FAILED = "realtime-audio-focus-transition-failed"
    private const val ERROR_CONNECTION_TIMEOUT = "realtime-connection-timeout"
    private const val ERROR_DISCONNECTED_TIMEOUT = "realtime-disconnected-timeout"
    private const val ERROR_DATA_CHANNEL_CLOSED = "realtime-event-channel-closed"
    private const val ERROR_PROVIDER_EVENT = "realtime-provider-error"
    private const val ERROR_SESSION_STOPPED = "realtime-session-stopped"
    private val initialized = AtomicBoolean(false)

    private fun monotonicMillis(): Long = System.nanoTime() / 1_000_000

    private fun initializeWebRtc(context: Context) {
      if (initialized.compareAndSet(false, true)) {
        PeerConnectionFactory.initialize(
          PeerConnectionFactory.InitializationOptions.builder(context)
            .createInitializationOptions(),
        )
      }
    }

    private fun rtcConfiguration(): PeerConnection.RTCConfiguration =
      PeerConnection.RTCConfiguration(emptyList()).apply {
        sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
        continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
      }

    private fun audioConstraints(): MediaConstraints =
      MediaConstraints().apply {
        optional += MediaConstraints.KeyValuePair("googEchoCancellation", "true")
        optional += MediaConstraints.KeyValuePair("googAutoGainControl", "true")
        optional += MediaConstraints.KeyValuePair("googNoiseSuppression", "true")
        optional += MediaConstraints.KeyValuePair("googHighpassFilter", "true")
      }

    private fun offerConstraints(): MediaConstraints =
      MediaConstraints().apply {
        mandatory += MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true")
        mandatory += MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false")
      }

    private fun readUtf8(buffer: ByteBuffer): String {
      val copy = buffer.slice()
      val bytes = ByteArray(copy.remaining())
      copy.get(bytes)
      return String(bytes, StandardCharsets.UTF_8)
    }
  }
}
