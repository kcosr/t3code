package expo.modules.t3voice

import android.os.Handler
import android.os.Looper

internal data class VoiceHostMediaSessionModel(
  val active: Boolean,
  val enabled: Boolean,
)

internal interface VoiceHostEffects {
  fun setForeground(types: Int, snapshot: T3VoiceNotificationSnapshot)
  fun removeForeground()
  fun notify(snapshot: T3VoiceNotificationSnapshot)
  fun setWakeLock(on: Boolean)
  fun setMediaSession(model: VoiceHostMediaSessionModel)
  fun releaseMediaSession()
  fun keepStarted(action: String, operationId: String)
  fun stopSelfIfIdle(startId: Int?)
}

internal interface VoiceHostMainDispatcher {
  fun isMainThread(): Boolean
  fun post(runnable: Runnable): Boolean
}

internal class AndroidVoiceHostMainDispatcher : VoiceHostMainDispatcher {
  private val handler = Handler(Looper.getMainLooper())

  override fun isMainThread(): Boolean = Looper.myLooper() === Looper.getMainLooper()
  override fun post(runnable: Runnable): Boolean = handler.post(runnable)
}

internal class VoiceHostDriver(
  private val dispatcher: VoiceHostMainDispatcher,
  private val effects: VoiceHostEffects,
  private val resultSink: VoiceKernelDriverResultSink,
  private val epoch: (String) -> VoiceKernelEpoch,
) {
  fun setForeground(types: Int, snapshot: T3VoiceNotificationSnapshot) =
    execute("set-foreground") { effects.setForeground(types, snapshot) }

  fun removeForeground() = execute("remove-foreground", effects::removeForeground)
  fun notify(snapshot: T3VoiceNotificationSnapshot) =
    execute("notify") { effects.notify(snapshot) }
  fun setWakeLock(on: Boolean) = execute("set-wake-lock") { effects.setWakeLock(on) }
  fun setMediaSession(model: VoiceHostMediaSessionModel) =
    execute("set-media-session") { effects.setMediaSession(model) }
  fun releaseMediaSession() = execute("release-media-session", effects::releaseMediaSession)
  fun keepStarted(action: String, operationId: String) =
    execute("keep-started") { effects.keepStarted(action, operationId) }
  fun stopSelfIfIdle(startId: Int? = null) =
    execute("stop-self-if-idle") { effects.stopSelfIfIdle(startId) }

  private fun execute(label: String, body: () -> Unit) {
    val armedEpoch = epoch(label)
    val runnable = Runnable {
      val result = runCatching(body)
      resultSink.post(
        VoiceKernelMessage.DriverResult(
          epoch = armedEpoch,
          driver = VoiceKernelDriver.HOST,
          resultKind = label,
          payload = VoiceKernelDriverResultPayload.HostCompleted(label, result),
        ),
      )
    }
    if (dispatcher.isMainThread()) runnable.run() else check(dispatcher.post(runnable)) {
      "Android main thread rejected host effect $label."
    }
  }
}
