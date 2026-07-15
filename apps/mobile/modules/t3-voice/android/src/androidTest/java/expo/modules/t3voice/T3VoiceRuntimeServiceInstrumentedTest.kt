package expo.modules.t3voice

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class T3VoiceRuntimeServiceInstrumentedTest {
  private val context: Context = ApplicationProvider.getApplicationContext()

  @Test
  fun mergedManifestDeclaresPrivateVoiceServiceAndRequiredPermissions() {
    val component = ComponentName(context, T3VoiceRuntimeService::class.java)
    @Suppress("DEPRECATION")
    val service = context.packageManager.getServiceInfo(component, PackageManager.GET_META_DATA)

    assertFalse(service.exported)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val requiredTypes =
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      assertEquals(requiredTypes, service.foregroundServiceType and requiredTypes)
    }

    @Suppress("DEPRECATION")
    val packageInfo =
      context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
    val permissions = packageInfo.requestedPermissions.orEmpty().toSet()
    assertTrue(Manifest.permission.RECORD_AUDIO in permissions)
    assertTrue(Manifest.permission.ACCESS_NETWORK_STATE in permissions)
    assertTrue(Manifest.permission.FOREGROUND_SERVICE in permissions)
    assertTrue(Manifest.permission.FOREGROUND_SERVICE_MICROPHONE in permissions)
    assertTrue(Manifest.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK in permissions)
  }

  @Test
  fun boundServiceReturnsToInactiveAndCanBeRecreated() {
    context.stopService(Intent(context, T3VoiceRuntimeService::class.java))
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }

    val first = bindService()
    try {
      assertNotNull(first.binder.get())
      assertEquals(T3VoiceRuntimePhase.IDLE, first.binder.get()!!.state.value.phase)
    } finally {
      context.unbindService(first.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }

    val second = bindService()
    try {
      assertNotNull(second.binder.get())
      assertEquals(T3VoiceRuntimePhase.IDLE, second.binder.get()!!.state.value.phase)
    } finally {
      context.unbindService(second.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }
  }

  @Test
  fun recordingSurvivesUnbindAndNotificationStopAfterRebind() {
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(
      context.packageName,
      Manifest.permission.RECORD_AUDIO,
    )
    val recordingId = UUID.randomUUID().toString()
    val first = bindService()
    val firstBinder = checkNotNull(first.binder.get())
    firstBinder.startRecording(recordingId, T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = null))
    waitUntil {
      firstBinder.state.value.phase == T3VoiceRuntimePhase.RECORDING &&
        firstBinder.state.value.isForeground &&
        firstBinder.state.value.activeRecordingId == recordingId
    }
    context.unbindService(first.connection)
    waitUntil {
      T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.RECORDING &&
        T3VoiceStateStore.state.value.activeRecordingId == recordingId
    }

    val second = bindService()
    try {
      val secondBinder = checkNotNull(second.binder.get())
      assertEquals(T3VoiceRuntimePhase.RECORDING, secondBinder.state.value.phase)
      assertEquals(recordingId, secondBinder.state.value.activeRecordingId)
      T3VoiceRuntimeService.requestStop(context)
      waitUntil {
        secondBinder.state.value.phase == T3VoiceRuntimePhase.IDLE &&
          !secondBinder.state.value.isForeground &&
          secondBinder.state.value.activeRecordingId == null
      }
    } finally {
      context.unbindService(second.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }
  }

  @Test
  fun realtimeSurvivesUnbindAndNotificationStopAfterRebind() {
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(
      context.packageName,
      Manifest.permission.RECORD_AUDIO,
    )
    val sessionId = UUID.randomUUID().toString()
    val first = bindService()
    val firstBinder = checkNotNull(first.binder.get())
    firstBinder.prepareRealtimeSession(
      nativeSessionId = sessionId,
      environmentOrigin = "https://127.0.0.1",
      audioRouteId = "system",
      callback =
        object : T3VoiceWebRtcResultCallback<String> {
          override fun onSuccess(result: String) = Unit

          override fun onFailure(code: String, message: String, cause: Throwable?) = Unit
        },
    )
    waitUntil {
      firstBinder.state.value.phase == T3VoiceRuntimePhase.REALTIME &&
        firstBinder.state.value.isForeground &&
        firstBinder.state.value.activeRealtimeSessionId == sessionId
    }
    context.unbindService(first.connection)
    waitUntil { T3VoiceStateStore.state.value.activeRealtimeSessionId == sessionId }

    val second = bindService()
    try {
      val secondBinder = checkNotNull(second.binder.get())
      assertEquals(sessionId, secondBinder.state.value.activeRealtimeSessionId)
      T3VoiceRuntimeService.requestStop(context)
      waitUntil {
        secondBinder.state.value.phase == T3VoiceRuntimePhase.IDLE &&
          !secondBinder.state.value.isForeground &&
          secondBinder.state.value.activeRealtimeSessionId == null
      }
    } finally {
      context.unbindService(second.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }
  }

  private fun bindService(): BoundService {
    val connected = CountDownLatch(1)
    val binder = AtomicReference<T3VoiceRuntimeService.VoiceBinder?>()
    val connection =
      object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
          binder.set(service as? T3VoiceRuntimeService.VoiceBinder)
          connected.countDown()
        }

        override fun onServiceDisconnected(name: ComponentName?) = Unit
      }
    assertTrue(
      context.bindService(
        Intent(context, T3VoiceRuntimeService::class.java),
        connection,
        Context.BIND_AUTO_CREATE,
      ),
    )
    assertTrue("Voice service did not bind", connected.await(3, TimeUnit.SECONDS))
    return BoundService(connection, binder)
  }

  private fun waitUntil(condition: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + 3_000
    while (!condition() && SystemClock.elapsedRealtime() < deadline) {
      SystemClock.sleep(10)
    }
    assertTrue("Voice service did not reach the expected state", condition())
  }

  private data class BoundService(
    val connection: ServiceConnection,
    val binder: AtomicReference<T3VoiceRuntimeService.VoiceBinder?>,
  )
}
