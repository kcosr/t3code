package expo.modules.t3voice

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

internal class VoiceRuntimeAuthorityRefreshWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : Worker(appContext, workerParams) {
  override fun doWork(): Result {
    val store = VoiceRuntimeAuthorityStore(applicationContext)
    val authority = store.loadForRefresh() ?: return Result.failure()
    if (!authority.readinessEnabled) return Result.failure()
    val attempt = runCatching { store.beginRefresh() }.getOrElse { return Result.failure() }
    startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESH_PENDING)
    return when (val result = VoiceRuntimeAuthorityRefreshClient().refresh(authority, attempt)) {
      is VoiceRuntimeRefreshResult.Success -> {
        runCatching { store.promoteRefresh(attempt, result.authority) {} }
          .getOrElse { return Result.failure() }
        VoiceRuntimeAuthorityRefreshScheduler.schedule(applicationContext, result.authority)
        runCatching { startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESHED) }
        Result.success()
      }
      is VoiceRuntimeRefreshResult.Retryable -> Result.retry()
      is VoiceRuntimeRefreshResult.Rejected -> {
        runCatching { store.rejectRefresh(attempt) }.getOrElse { return Result.failure() }
        VoiceRuntimeAuthorityRefreshScheduler.cancel(applicationContext)
        runCatching { startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESH_REJECTED) }
        Result.failure()
      }
    }
  }

  private fun startRuntimeService(actionValue: String) {
    val intent = Intent(applicationContext, T3VoiceRuntimeService::class.java).apply {
      action = actionValue
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      applicationContext.startForegroundService(intent)
    } else {
      applicationContext.startService(intent)
    }
  }
}

internal object VoiceRuntimeAuthorityRefreshScheduler {
  private const val WORK_NAME = "t3-voice-runtime-authority-refresh"
  private const val REFRESH_LEAD_MILLIS = 24L * 60L * 60L * 1_000L
  private const val MINIMUM_DELAY_MILLIS = 1_000L

  fun schedule(
    context: Context,
    authority: VoiceRuntimePersistedAuthority,
    nowEpochMillis: Long = System.currentTimeMillis(),
  ) {
    if (!authority.readinessEnabled) {
      cancel(context)
      return
    }
    val delay = delayMillis(authority.expiresAtEpochMillis, nowEpochMillis)
    val request = OneTimeWorkRequestBuilder<VoiceRuntimeAuthorityRefreshWorker>()
      .setInitialDelay(delay, TimeUnit.MILLISECONDS)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context.applicationContext)
      .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
  }

  fun cancel(context: Context) {
    WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
  }

  internal fun delayMillis(expiresAtEpochMillis: Long, nowEpochMillis: Long): Long =
    (expiresAtEpochMillis - REFRESH_LEAD_MILLIS - nowEpochMillis)
      .coerceAtLeast(MINIMUM_DELAY_MILLIS)
}
