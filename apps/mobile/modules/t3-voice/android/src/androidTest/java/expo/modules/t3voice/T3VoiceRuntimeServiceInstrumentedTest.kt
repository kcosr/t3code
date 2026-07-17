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
      assertEquals(T3VoiceRuntimePhase.IDLE, T3VoiceStateStore.state.value.phase)
    } finally {
      context.unbindService(first.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }

    val second = bindService()
    try {
      assertNotNull(second.binder.get())
      assertEquals(T3VoiceRuntimePhase.IDLE, T3VoiceStateStore.state.value.phase)
    } finally {
      context.unbindService(second.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }
  }

  @Test
  fun recordingOwnsForegroundUntilCancelledAndServiceCanRebind() {
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(
      context.packageName,
      Manifest.permission.RECORD_AUDIO,
    )
    val recordingId = UUID.randomUUID().toString()
    val first = bindService()
    try {
      val binder = checkNotNull(first.binder.get())
      binder.startRecording(recordingId, T3VoiceEndpointDetectionConfig(noSpeechTimeoutMs = null))
      waitUntil {
        T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.RECORDING &&
          T3VoiceStateStore.state.value.isForeground &&
          T3VoiceStateStore.state.value.activeRecordingId == recordingId
      }
      binder.cancelRecording(recordingId)
      waitUntil {
        T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE &&
          !T3VoiceStateStore.state.value.isForeground &&
          T3VoiceStateStore.state.value.activeRecordingId == null
      }
    } finally {
      context.unbindService(first.connection)
    }
    waitUntil { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.INACTIVE }

    val second = bindService()
    try {
      assertEquals(T3VoiceRuntimePhase.IDLE, T3VoiceStateStore.state.value.phase)
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
