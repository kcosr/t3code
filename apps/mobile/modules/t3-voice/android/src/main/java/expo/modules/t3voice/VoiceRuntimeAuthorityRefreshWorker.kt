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
    val readinessStore = T3VoiceReadinessStore(applicationContext)
    val authority = store.loadForRefresh() ?: return Result.failure()
    val mode = T3VoiceAuthorityRefreshAdmissionPolicy.mode(
      authority,
      readinessStore.read(),
      readinessStore.disabledAuthorityFence(),
      store.hasPendingRefresh(),
    )
    val attempt = when (mode) {
      T3VoiceAuthorityRefreshAdmissionPolicy.Mode.NORMAL ->
        runCatching { store.beginRefresh() }.getOrElse { return Result.failure() }
      T3VoiceAuthorityRefreshAdmissionPolicy.Mode.DISABLED_RECOVERY ->
        runCatching { store.resumeDisabledRefresh() }
        .getOrNull()
        ?.takeIf { it.first == authority }
        ?.second
        ?: return Result.failure()
      T3VoiceAuthorityRefreshAdmissionPolicy.Mode.REJECT -> return Result.failure()
    }
    if (!canRefresh(authority, readinessStore) &&
      !isDurablyDisabled(authority, readinessStore)) return Result.failure()
    if (mode == T3VoiceAuthorityRefreshAdmissionPolicy.Mode.NORMAL) {
      startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESH_PENDING)
    }
    val requestAuthority = if (mode ==
      T3VoiceAuthorityRefreshAdmissionPolicy.Mode.DISABLED_RECOVERY) {
      authority.copy(readinessEnabled = true)
    } else {
      authority
    }
    return when (val result = VoiceRuntimeAuthorityRefreshClient().refresh(requestAuthority, attempt)) {
      is VoiceRuntimeRefreshResult.Success -> {
        if (canRefresh(authority, readinessStore)) {
          val promoted = runCatching { store.promoteRefresh(attempt, result.authority) {} }
          if (promoted.isFailure) {
            if (!isDurablyDisabled(authority, readinessStore) ||
              runCatching {
                store.promoteDisabledRefresh(attempt, result.authority)
              }.isFailure) {
              return Result.failure()
            }
            VoiceRuntimeAuthorityRefreshScheduler.cancel(applicationContext)
            runCatching { startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESHED) }
            return Result.success()
          }
          VoiceRuntimeAuthorityRefreshScheduler.schedule(applicationContext, result.authority)
          if (!canRefresh(result.authority, readinessStore)) {
            VoiceRuntimeAuthorityRefreshScheduler.cancel(applicationContext)
          }
        } else if (isDurablyDisabled(authority, readinessStore)) {
          runCatching { store.promoteDisabledRefresh(attempt, result.authority) }
            .getOrElse { return Result.failure() }
          VoiceRuntimeAuthorityRefreshScheduler.cancel(applicationContext)
        } else {
          return Result.failure()
        }
        runCatching { startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESHED) }
        Result.success()
      }
      is VoiceRuntimeRefreshResult.Retryable ->
        if (isDurablyDisabled(authority, readinessStore)) {
          Result.retry()
        } else {
          Result.retry()
        }
      is VoiceRuntimeRefreshResult.Rejected -> {
        if (isDurablyDisabled(authority, readinessStore)) {
          runCatching { store.rejectDisabledRefresh(attempt) }
            .getOrElse { return Result.failure() }
          VoiceRuntimeAuthorityRefreshScheduler.cancel(applicationContext)
          runCatching { startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESH_REJECTED) }
          return Result.failure()
        }
        runCatching { store.rejectRefresh(attempt) }.getOrElse { return Result.failure() }
        VoiceRuntimeAuthorityRefreshScheduler.cancel(applicationContext)
        runCatching { startRuntimeService(T3VoiceRuntimeService.ACTION_AUTHORITY_REFRESH_REJECTED) }
        Result.failure()
      }
    }
  }

  private fun canRefresh(
    authority: VoiceRuntimePersistedAuthority,
    readinessStore: T3VoiceReadinessStore,
  ): Boolean = T3VoiceAuthorityRefreshAdmissionPolicy.canRefresh(
    authority,
    readinessStore.read(),
    readinessStore.disabledAuthorityFence(),
  )

  private fun isDurablyDisabled(
    authority: VoiceRuntimePersistedAuthority,
    readinessStore: T3VoiceReadinessStore,
  ): Boolean {
    return T3VoiceAuthorityRefreshAdmissionPolicy.isDurablyDisabled(
      authority,
      readinessStore.read(),
      readinessStore.disabledAuthorityFence(),
    )
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
    WorkManager.getInstance(context.applicationContext)
      .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request(delay))
  }

  fun scheduleDisabledRecovery(context: Context) {
    val request = request(delayMillis = 0)
    WorkManager.getInstance(context.applicationContext)
      .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
  }

  fun cancel(context: Context) {
    WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
  }

  internal fun delayMillis(expiresAtEpochMillis: Long, nowEpochMillis: Long): Long =
    (expiresAtEpochMillis - REFRESH_LEAD_MILLIS - nowEpochMillis)
      .coerceAtLeast(MINIMUM_DELAY_MILLIS)

  private fun request(delayMillis: Long) =
    OneTimeWorkRequestBuilder<VoiceRuntimeAuthorityRefreshWorker>()
      .setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
      .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .build()
}
