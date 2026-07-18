package expo.modules.t3voice

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock

internal object T3VoiceReadinessExpiryAlarmPolicy {
  fun triggerAtElapsedRealtime(
    expiresAtEpochMillis: Long,
    nowEpochMillis: Long,
    nowElapsedRealtimeMillis: Long,
  ): Long {
    require(nowElapsedRealtimeMillis >= 0) { "Elapsed realtime cannot be negative." }
    val remaining = (expiresAtEpochMillis - nowEpochMillis).coerceAtLeast(0)
    return nowElapsedRealtimeMillis +
      remaining.coerceAtMost(Long.MAX_VALUE - nowElapsedRealtimeMillis)
  }
}

internal interface T3VoiceReadinessExpiryAlarm {
  fun replace(
    generation: Long,
    expiresAtEpochMillis: Long,
  )

  fun cancel()
}

internal class T3VoiceAndroidReadinessExpiryAlarm(
  context: Context,
) : T3VoiceReadinessExpiryAlarm {
  private val applicationContext = context.applicationContext
  private val alarmManager = applicationContext.getSystemService(AlarmManager::class.java)
  private var pendingIntent: PendingIntent? = null

  override fun replace(
    generation: Long,
    expiresAtEpochMillis: Long,
  ) {
    require(generation > 0) { "Readiness generation must be positive." }
    cancel()
    val intent =
      Intent(applicationContext, T3VoiceRuntimeService::class.java).apply {
        action = T3VoiceRuntimeService.ACTION_READINESS_EXPIRY
        data =
          Uri.Builder()
            .scheme("t3voice")
            .authority("readiness-expiry")
            .appendPath(generation.toString())
            .build()
        putExtra(T3VoiceRuntimeService.EXTRA_READINESS_GENERATION, generation)
      }
    val replacement =
      PendingIntent.getService(
        applicationContext,
        READINESS_EXPIRY_REQUEST_CODE,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    pendingIntent = replacement
    alarmManager.setAndAllowWhileIdle(
      AlarmManager.ELAPSED_REALTIME_WAKEUP,
      T3VoiceReadinessExpiryAlarmPolicy.triggerAtElapsedRealtime(
        expiresAtEpochMillis = expiresAtEpochMillis,
        nowEpochMillis = T3VoiceTime.nowEpochMillis(),
        nowElapsedRealtimeMillis = SystemClock.elapsedRealtime(),
      ),
      replacement,
    )
  }

  override fun cancel() {
    val current = pendingIntent ?: return
    pendingIntent = null
    alarmManager.cancel(current)
    current.cancel()
  }

  private companion object {
    const val READINESS_EXPIRY_REQUEST_CODE = 3110
  }
}

internal class T3VoiceReadinessExpiryCoordinator(
  private val owner: T3VoiceReadinessOwner,
  private val alarm: T3VoiceReadinessExpiryAlarm,
  private val onExpired: (T3VoiceReadinessSnapshot.NeedsRefresh) -> Unit,
) {
  fun replace(configuration: T3VoiceReadinessConfiguration) {
    val ready = owner.snapshot() as? T3VoiceReadinessSnapshot.Ready
    val prepared = configuration.preparedStart
    if (
      ready == null ||
      ready.generation != configuration.generation ||
      prepared == null
    ) {
      alarm.cancel()
      return
    }
    alarm.replace(
      generation = configuration.generation,
      expiresAtEpochMillis =
        T3VoiceTime.parseIsoEpochMillis(
          prepared.session.expiresAt,
          "native session expiration",
        ),
    )
  }

  fun cancel() {
    alarm.cancel()
  }

  fun onAlarm(generation: Long) {
    when (val decision = owner.start(generation)) {
      is T3VoiceReadinessStartDecision.Expired -> onExpired(decision.snapshot)
      is T3VoiceReadinessStartDecision.Start ->
        owner.checkpoint().configuration
          ?.takeIf { it.generation == generation }
          ?.let(::replace)
      T3VoiceReadinessStartDecision.IgnoreStale,
      T3VoiceReadinessStartDecision.Unavailable,
      -> Unit
    }
  }
}
