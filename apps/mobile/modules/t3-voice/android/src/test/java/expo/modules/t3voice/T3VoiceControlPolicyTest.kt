package expo.modules.t3voice

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceControlPolicyTest {
  @Test
  fun `conditional disable accepts only exact or authority-free idle ownership`() {
    assertTrue(T3VoiceConditionalDisablePolicy.canDisable(null, null, 0, emptyList(), false))
    assertTrue(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-1", 7, 7, listOf("runtime-1" to 7), false))
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      null, null, 7, listOf("runtime-1" to 7), false))
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-1", null, 7, listOf("runtime-1" to 7), false))
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      null, 7, 7, emptyList(), false))
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-2", 7, 7, listOf("runtime-1" to 7), false))
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-1", 7, 7, listOf("runtime-1" to 7, "runtime-2" to 7), false))
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-1", 7, 7, listOf("runtime-1" to 7), true))
  }

  @Test
  fun `readiness preparation refuses every active native ownership shape`() {
    assertTrue(T3VoiceBackgroundPreparationPolicy.canPrepare(
      T3VoiceRuntimePhase.IDLE, false, false, false))
    assertFalse(T3VoiceBackgroundPreparationPolicy.canPrepare(
      T3VoiceRuntimePhase.RECORDING, false, false, false))
    assertFalse(T3VoiceBackgroundPreparationPolicy.canPrepare(
      T3VoiceRuntimePhase.IDLE, true, false, false))
    assertFalse(T3VoiceBackgroundPreparationPolicy.canPrepare(
      T3VoiceRuntimePhase.IDLE, false, true, false))
    assertFalse(T3VoiceBackgroundPreparationPolicy.canPrepare(
      T3VoiceRuntimePhase.IDLE, false, false, true))
  }

  @Test
  fun `conditional disable refuses durable thread ownership before service restore`() {
    val startupHasDurableThreadOperation = true
    assertFalse(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-1",
      7,
      7,
      listOf("runtime-1" to 7),
      nativeVoiceActive = startupHasDurableThreadOperation,
    ))
  }
  @Test
  fun `idle realtime primary starts natively and never falls back to React`() {
    assertEquals(
      T3VoiceControlDecision.START_NATIVE_REALTIME,
      T3VoiceControlPolicy.decide(
        T3VoiceControlCommand.PRIMARY,
        T3VoiceRuntimePhase.IDLE,
        controllerAttached = true,
        nativeRealtimeAvailable = true,
      ),
    )
    assertEquals(
      T3VoiceControlDecision.IGNORE,
      T3VoiceControlPolicy.decide(
        T3VoiceControlCommand.PRIMARY,
        T3VoiceRuntimePhase.IDLE,
        controllerAttached = true,
        nativeRealtimeAvailable = false,
      ),
    )
  }

  @Test
  fun `idle thread primary retains the thread controller handoff`() {
    assertEquals(
      T3VoiceControlDecision.REQUEST_CONTROLLER_START,
      T3VoiceControlPolicy.decide(
        T3VoiceControlCommand.PRIMARY,
        T3VoiceRuntimePhase.IDLE,
        controllerAttached = true,
        readinessMode = T3VoiceReadinessMode.THREAD,
      ),
    )
  }

  @Test
  fun `idle thread primary uses native execution when authorized`() {
    assertEquals(
      T3VoiceControlDecision.START_NATIVE_THREAD,
      T3VoiceControlPolicy.decide(
        T3VoiceControlCommand.PRIMARY,
        T3VoiceRuntimePhase.IDLE,
        controllerAttached = false,
        nativeThreadAvailable = true,
        readinessMode = T3VoiceReadinessMode.THREAD,
      ),
    )
  }

  @Test
  fun `primary stops every active operation`() {
    listOf(
      T3VoiceRuntimePhase.RECORDING,
      T3VoiceRuntimePhase.PLAYING,
      T3VoiceRuntimePhase.REALTIME,
    ).forEach { phase ->
      assertEquals(
        T3VoiceControlDecision.STOP_ACTIVE,
        T3VoiceControlPolicy.decide(
          T3VoiceControlCommand.PRIMARY,
          phase,
          controllerAttached = false,
        ),
      )
    }
  }

  @Test
  fun `media buttons accept one down event only`() {
    assertEquals(
      T3VoiceControlCommand.PRIMARY,
      T3VoiceControlPolicy.mediaButtonCommand(
        KeyEvent.ACTION_DOWN,
        0,
        KeyEvent.KEYCODE_HEADSETHOOK,
      ),
    )
    assertEquals(
      null,
      T3VoiceControlPolicy.mediaButtonCommand(
        KeyEvent.ACTION_DOWN,
        1,
        KeyEvent.KEYCODE_HEADSETHOOK,
      ),
    )
    assertEquals(
      null,
      T3VoiceControlPolicy.mediaButtonCommand(
        KeyEvent.ACTION_UP,
        0,
        KeyEvent.KEYCODE_HEADSETHOOK,
      ),
    )
    assertEquals(
      null,
      T3VoiceControlPolicy.mediaButtonCommand(
        KeyEvent.ACTION_DOWN,
        0,
        KeyEvent.KEYCODE_VOLUME_UP,
      ),
    )
  }

  @Test
  fun `pause and stop media keys never map to start`() {
    listOf(KeyEvent.KEYCODE_MEDIA_PAUSE, KeyEvent.KEYCODE_MEDIA_STOP).forEach { keyCode ->
      val command = T3VoiceControlPolicy.mediaButtonCommand(KeyEvent.ACTION_DOWN, 0, keyCode)
      assertEquals(T3VoiceControlCommand.STOP, command)
      assertEquals(
        T3VoiceControlDecision.IGNORE,
        T3VoiceControlPolicy.decide(
          requireNotNull(command),
          T3VoiceRuntimePhase.IDLE,
          controllerAttached = true,
        ),
      )
    }
  }

  @Test
  fun `play style media keys map to primary`() {
    listOf(
      KeyEvent.KEYCODE_MEDIA_PLAY,
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_HEADSETHOOK,
    ).forEach { keyCode ->
      assertEquals(
        T3VoiceControlCommand.PRIMARY,
        T3VoiceControlPolicy.mediaButtonCommand(KeyEvent.ACTION_DOWN, 0, keyCode),
      )
    }
  }

  @Test
  fun `readiness lifecycle gates sticky service on notification permission`() {
    val denied = T3VoiceReadinessConfig(enabled = true, notificationPermissionGranted = false)
    val granted = denied.copy(notificationPermissionGranted = true)
    assertFalse(T3VoiceForegroundLifecyclePolicy.shouldRemainStarted(denied))
    assertTrue(T3VoiceForegroundLifecyclePolicy.shouldRemainStarted(granted))
    assertEquals(
      android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      T3VoiceForegroundLifecyclePolicy.readinessServiceTypes(granted, false),
    )
    val permitted = granted.copy(microphonePermissionGranted = true)
    assertTrue(T3VoiceForegroundLifecyclePolicy.readinessServiceTypes(permitted, true) != 0)
    val mediaOnly = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    assertEquals(
      T3VoiceForegroundLifecyclePolicy.readinessServiceTypes(permitted, true),
      T3VoiceForegroundLifecyclePolicy.activeServiceTypes(mediaOnly, permitted, true),
    )
  }

  @Test
  fun `reconciliation preserves active operation service types`() {
    val ready =
      T3VoiceReadinessConfig(
        enabled = true,
        microphonePermissionGranted = true,
        notificationPermissionGranted = true,
      )
    val microphone = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    val media = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    assertEquals(
      microphone or media,
      T3VoiceForegroundLifecyclePolicy.reconciledServiceTypes(
        T3VoiceRuntimePhase.RECORDING,
        ready,
        false,
      ),
    )
    assertEquals(
      microphone or media,
      T3VoiceForegroundLifecyclePolicy.reconciledServiceTypes(
        T3VoiceRuntimePhase.REALTIME,
        ready,
        false,
      ),
    )
    assertEquals(
      microphone or media,
      T3VoiceForegroundLifecyclePolicy.reconciledServiceTypes(
        T3VoiceRuntimePhase.PLAYING,
        ready,
        true,
      ),
    )
  }

  @Test
  fun `foreground type validation accepts only nonzero declared subsets`() {
    val microphone = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    val media = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    assertEquals(microphone, T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(microphone))
    assertEquals(media, T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(media))
    assertEquals(
      microphone or media,
      T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(microphone or media),
    )
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(0)
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(1 shl 30)
    }
  }

  @Test
  fun `repeated disable does not create a new generation`() {
    val enabled = T3VoiceReadinessConfig(enabled = true, generation = 8)
    assertTrue(T3VoiceDisablePolicy.shouldCreatePendingDisable(enabled, null))
    val disabled = enabled.copy(enabled = false, generation = 9)
    val pending = T3VoiceRuntimeEvent.ReadinessDisabled(9, "notification")
    assertFalse(T3VoiceDisablePolicy.shouldCreatePendingDisable(disabled, pending))
    assertFalse(T3VoiceDisablePolicy.shouldCreatePendingDisable(disabled, null))
  }

  @Test
  fun `sticky readiness retains microphone ownership without React`() {
    val restored =
      T3VoiceReadinessConfig(
        enabled = true,
        microphonePermissionGranted = true,
        notificationPermissionGranted = true,
      )
    assertTrue(T3VoiceForegroundLifecyclePolicy.shouldRemainStarted(restored))
    assertEquals(
      android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      T3VoiceForegroundLifecyclePolicy.reconciledServiceTypes(
        T3VoiceRuntimePhase.IDLE,
        restored,
        controllerAttached = false,
      ),
    )
  }

  @Test
  fun `readiness payload equality ignores generation only`() {
    val first =
      T3VoiceReadinessConfig(
        enabled = true,
        notificationPermissionGranted = true,
        generation = 4,
      )
    assertTrue(first.samePayload(first.copy(generation = 9)))
    assertFalse(first.samePayload(first.copy(autoRearm = true, generation = 9)))
  }

  @Test
  fun `pending notification disable fences stale re-enable`() {
    val pending = T3VoiceRuntimeEvent.ReadinessDisabled(4, "notification")
    assertFalse(
      T3VoiceReadinessReconciliationPolicy.canApply(
        T3VoiceReadinessConfig(enabled = true),
        pending,
      ),
    )
    assertTrue(
      T3VoiceReadinessReconciliationPolicy.canApply(
        T3VoiceReadinessConfig(enabled = false),
        pending,
      ),
    )
  }
}
