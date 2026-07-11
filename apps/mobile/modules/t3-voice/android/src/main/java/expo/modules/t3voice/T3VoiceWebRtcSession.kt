package expo.modules.t3voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaRecorder
import android.util.Log
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

internal class T3VoiceWebRtcSession(
  context: Context,
  private val onStateChanged: (String, String, Boolean) -> Unit,
  private val onError: (String, String, String, Boolean) -> Unit,
  private val onTerminated: (String, String, String, Boolean) -> Unit,
) {
  private data class ActiveSession(
    val sessionId: String,
    val peerConnection: PeerConnection,
    val audioSource: AudioSource,
    val audioTrack: AudioTrack,
    val dataChannel: DataChannel,
    var muted: Boolean = false,
    var localDescriptionSet: Boolean = false,
    var iceGatheringComplete: Boolean = false,
    var offerDelivered: Boolean = false,
    var answerApplied: Boolean = false,
    var offerCallback: T3VoiceWebRtcResultCallback<String>? = null,
    var answerCallback: T3VoiceWebRtcResultCallback<Unit>? = null,
    var offerTimeout: ScheduledFuture<*>? = null,
  )

  private val applicationContext = context.applicationContext
  private val lock = Any()
  private val scheduler = Executors.newSingleThreadScheduledExecutor()
  private val audioRouter = T3VoiceAudioRouter(applicationContext)
  private val terminalLatch = T3VoiceRealtimeTerminalLatch()
  private val audioDeviceModule: JavaAudioDeviceModule
  private val peerConnectionFactory: PeerConnectionFactory
  private var active: ActiveSession? = null

  init {
    initializeWebRtc(applicationContext)
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
        .setAudioRecordErrorCallback(AudioRecordErrorCallback())
        .setAudioTrackErrorCallback(AudioTrackErrorCallback())
        .createAudioDeviceModule()
    peerConnectionFactory =
      PeerConnectionFactory.builder()
        .setAudioDeviceModule(audioDeviceModule)
        .createPeerConnectionFactory()
  }

  fun prepare(sessionId: String, callback: T3VoiceWebRtcResultCallback<String>) {
    require(sessionId.isNotBlank()) { "nativeSessionId must be a non-empty string." }
    synchronized(lock) {
      check(active == null) { "A Realtime voice session is already active." }
    }

    val audioSource = peerConnectionFactory.createAudioSource(audioConstraints())
    val audioTrack = peerConnectionFactory.createAudioTrack(LOCAL_AUDIO_TRACK_ID, audioSource)
    audioTrack.setEnabled(true)
    val peerConnection =
      peerConnectionFactory.createPeerConnection(
        rtcConfiguration(),
        PeerObserver(sessionId),
      )
        ?: run {
          audioTrack.dispose()
          audioSource.dispose()
          error("WebRTC could not create a peer connection.")
        }
    val sender = peerConnection.addTrack(audioTrack, listOf(LOCAL_MEDIA_STREAM_ID))
    if (sender == null) {
      peerConnection.dispose()
      audioTrack.dispose()
      audioSource.dispose()
      error("WebRTC could not attach the microphone track.")
    }
    peerConnection.setAudioPlayout(true)
    peerConnection.setAudioRecording(true)
    val dataChannel =
      peerConnection.createDataChannel(
        DATA_CHANNEL_LABEL,
        DataChannel.Init().apply { ordered = true },
      )
    dataChannel.registerObserver(DataChannelObserver(sessionId, dataChannel))
    val session =
      ActiveSession(
        sessionId = sessionId,
        peerConnection = peerConnection,
        audioSource = audioSource,
        audioTrack = audioTrack,
        dataChannel = dataChannel,
        offerCallback = callback,
      )
    synchronized(lock) {
      check(active == null) { "A Realtime voice session started concurrently." }
      active = session
      terminalLatch.activate(sessionId)
      session.offerTimeout =
        scheduler.schedule(
          { fail(sessionId, ERROR_ICE_TIMEOUT, "WebRTC ICE gathering timed out.", null, true) },
          ICE_GATHERING_TIMEOUT_SECONDS,
          TimeUnit.SECONDS,
        )
    }
    try {
      audioRouter.start()
      onStateChanged(sessionId, STATE_PREPARING, false)
      Log.i(LOG_TAG, "offer-requested sessionId=$sessionId")
      peerConnection.createOffer(OfferObserver(sessionId), offerConstraints())
    } catch (cause: Throwable) {
      fail(
        sessionId,
        ERROR_PREPARE_FAILED,
        cause.message ?: "Could not prepare the Realtime peer.",
        cause,
        false,
      )
    }
  }

  fun applyAnswer(
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
            Log.i(LOG_TAG, "answer-applied sessionId=$sessionId")
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

  fun setMuted(sessionId: String, muted: Boolean) {
    val track =
      synchronized(lock) {
        val session = requireActive(sessionId)
        check(session.audioTrack.setEnabled(!muted)) { "WebRTC could not change microphone state." }
        session.muted = muted
        session.audioTrack
      }
    audioDeviceModule.setMicrophoneMute(muted)
    check(track.enabled() != muted) { "WebRTC microphone state did not change." }
    val state = connectionState(sessionId)
    onStateChanged(sessionId, state, muted)
  }

  fun routes(): List<Map<String, Any>> = audioRouter.routes().map(T3VoiceAudioRoute::toResultBody)

  fun selectRoute(sessionId: String, routeId: String): List<Map<String, Any>> {
    synchronized(lock) { requireActive(sessionId) }
    audioRouter.select(routeId)
    return routes()
  }

  fun stop(sessionId: String): Boolean {
    Log.i(LOG_TAG, "stop-requested sessionId=$sessionId")
    val session =
      synchronized(lock) {
        val current = active ?: return false
        check(current.sessionId == sessionId) {
          "Realtime session $sessionId does not own the active peer."
        }
        active = null
        current
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
      Log.i(LOG_TAG, "terminal sessionId=$sessionId outcome=$OUTCOME_ENDED code=$ERROR_SESSION_STOPPED")
      onTerminated(sessionId, OUTCOME_ENDED, ERROR_SESSION_STOPPED, false)
    }
    onStateChanged(sessionId, STATE_CLOSED, session.muted)
    return true
  }

  fun release() {
    val session = synchronized(lock) { active?.also { active = null } }
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
    peerConnectionFactory.dispose()
    audioDeviceModule.release()
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
            Triple(callback, description, session.muted)
          }
        }
      }
    if (result != null) {
      Log.i(LOG_TAG, "offer-ready sessionId=$sessionId")
      onStateChanged(sessionId, STATE_OFFER_READY, result.third)
      result.first?.onSuccess(result.second)
    }
  }

  private fun updateConnectionState(sessionId: String, state: PeerConnection.PeerConnectionState) {
    Log.i(LOG_TAG, "peer-connection-state sessionId=$sessionId state=${state.name.lowercase()}")
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
    val muted = synchronized(lock) { active?.takeIf { it.sessionId == sessionId }?.muted } ?: return
    onStateChanged(sessionId, normalized, muted)
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
    session.offerCallback?.onFailure(code, message, cause)
    session.offerCallback = null
    session.answerCallback?.onFailure(code, message, cause)
    session.answerCallback = null
    releaseSession(session)
    audioRouter.stop()
    if (terminalLatch.claim(sessionId)) {
      Log.w(LOG_TAG, "terminal sessionId=$sessionId outcome=$OUTCOME_FAILED code=$code")
      onTerminated(sessionId, OUTCOME_FAILED, code, recoverable)
    }
    onStateChanged(sessionId, STATE_FAILED, session.muted)
  }

  private fun releaseSession(session: ActiveSession) {
    session.offerTimeout?.cancel(false)
    session.offerTimeout = null
    runCatching { session.dataChannel.unregisterObserver() }
    runCatching { session.dataChannel.close() }
    runCatching { session.dataChannel.dispose() }
    runCatching { session.peerConnection.close() }
    runCatching { session.peerConnection.dispose() }
    runCatching { session.audioTrack.dispose() }
    runCatching { session.audioSource.dispose() }
  }

  private fun requireActive(sessionId: String): ActiveSession {
    val session = active ?: error("No Realtime voice session is active.")
    check(session.sessionId == sessionId) {
      "Realtime session $sessionId does not own the active peer."
    }
    return session
  }

  private fun isMuted(sessionId: String): Boolean = synchronized(lock) { requireActive(sessionId).muted }

  private fun connectionState(sessionId: String): String {
    val session = synchronized(lock) { requireActive(sessionId) }
    return when {
      session.peerConnection.connectionState() == PeerConnection.PeerConnectionState.CONNECTED ->
        STATE_CONNECTED
      session.answerApplied -> STATE_CONNECTING
      session.offerDelivered -> STATE_OFFER_READY
      else -> STATE_PREPARING
    }
  }

  private inner class OfferObserver(private val sessionId: String) : BaseSdpObserver() {
    override fun onCreateSuccess(description: SessionDescription?) {
      Log.i(LOG_TAG, "offer-created sessionId=$sessionId")
      if (description == null || description.description.isBlank()) {
        fail(sessionId, ERROR_OFFER_FAILED, "WebRTC created an empty SDP offer.", null, false)
        return
      }
      val peer = synchronized(lock) { active?.takeIf { it.sessionId == sessionId }?.peerConnection }
        ?: return
      peer.setLocalDescription(
        object : BaseSdpObserver() {
          override fun onSetSuccess() {
            Log.i(LOG_TAG, "local-description-set sessionId=$sessionId")
            synchronized(lock) {
              active?.takeIf { it.sessionId == sessionId }?.localDescriptionSet = true
            }
            maybeDeliverOffer(sessionId)
          }

          override fun onSetFailure(message: String?) {
            Log.w(LOG_TAG, "local-description-rejected sessionId=$sessionId")
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
      Log.w(LOG_TAG, "offer-create-failed sessionId=$sessionId")
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
      Log.i(
        LOG_TAG,
        "signaling-state sessionId=$sessionId state=${state?.name?.lowercase() ?: "unknown"}",
      )
    }

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
      Log.i(
        LOG_TAG,
        "ice-connection-state sessionId=$sessionId state=${state?.name?.lowercase() ?: "unknown"}",
      )
    }

    override fun onIceConnectionReceivingChange(receiving: Boolean) {
      Log.i(LOG_TAG, "ice-receiving sessionId=$sessionId receiving=$receiving")
    }

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {
      Log.i(
        LOG_TAG,
        "ice-gathering-state sessionId=$sessionId state=${state?.name?.lowercase() ?: "unknown"}",
      )
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
      Log.i(LOG_TAG, "data-channel-state sessionId=$sessionId state=${state.name.lowercase()}")
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
        Log.w(LOG_TAG, "provider-error-event sessionId=$sessionId")
        onError(
          sessionId,
          ERROR_PROVIDER_EVENT,
          "The Realtime provider reported an error.",
          true,
        )
      }
    }
  }

  private inner class AudioRecordErrorCallback : JavaAudioDeviceModule.AudioRecordErrorCallback {
    override fun onWebRtcAudioRecordInitError(message: String?) =
      reportAudioError("realtime-microphone-init", message)

    override fun onWebRtcAudioRecordStartError(
      code: JavaAudioDeviceModule.AudioRecordStartErrorCode?,
      message: String?,
    ) = reportAudioError("realtime-microphone-start", message)

    override fun onWebRtcAudioRecordError(message: String?) =
      reportAudioError("realtime-microphone", message)
  }

  private inner class AudioTrackErrorCallback : JavaAudioDeviceModule.AudioTrackErrorCallback {
    override fun onWebRtcAudioTrackInitError(message: String?) =
      reportAudioError("realtime-playout-init", message)

    override fun onWebRtcAudioTrackStartError(
      code: JavaAudioDeviceModule.AudioTrackStartErrorCode?,
      message: String?,
    ) = reportAudioError("realtime-playout-start", message)

    override fun onWebRtcAudioTrackError(message: String?) =
      reportAudioError("realtime-playout", message)
  }

  private fun reportAudioError(
    code: String,
    @Suppress("UNUSED_PARAMETER") providerMessage: String?,
  ) {
    val sessionId = synchronized(lock) { active?.sessionId } ?: return
    Log.w(LOG_TAG, "audio-error sessionId=$sessionId code=$code")
    onError(sessionId, code, "Realtime audio failed.", true)
  }

  private open class BaseSdpObserver : SdpObserver {
    override fun onCreateSuccess(description: SessionDescription?) = Unit

    override fun onSetSuccess() = Unit

    override fun onCreateFailure(message: String?) = Unit

    override fun onSetFailure(message: String?) = Unit
  }

  companion object {
    private const val LOG_TAG = "T3VoiceWebRtc"
    private const val LOCAL_AUDIO_TRACK_ID = "t3-audio"
    private const val LOCAL_MEDIA_STREAM_ID = "t3-media"
    private const val DATA_CHANNEL_LABEL = "oai-events"
    private const val ICE_GATHERING_TIMEOUT_SECONDS = 15L
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
    private const val ERROR_DATA_CHANNEL_CLOSED = "realtime-event-channel-closed"
    private const val ERROR_PROVIDER_EVENT = "realtime-provider-error"
    private const val ERROR_SESSION_STOPPED = "realtime-session-stopped"
    private val initialized = AtomicBoolean(false)

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
