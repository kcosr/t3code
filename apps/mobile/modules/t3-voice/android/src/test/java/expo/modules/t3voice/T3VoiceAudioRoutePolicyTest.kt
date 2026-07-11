package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class T3VoiceAudioRoutePolicyTest {
  @Test
  fun normalizesClassicAndLeBluetoothDevicesToOneCanonicalRoute() {
    listOf(
      T3VoiceAudioDeviceKind.BLUETOOTH_CLASSIC,
      T3VoiceAudioDeviceKind.BLUETOOTH_LE_HEADSET,
      T3VoiceAudioDeviceKind.BLUETOOTH_LE_SPEAKER,
    ).forEach { device ->
      assertEquals(T3VoiceAudioRouteKind.BLUETOOTH, T3VoiceAudioRoutePolicy.normalize(device))
    }
  }

  @Test
  fun normalizesNonBluetoothDevicesWithoutAliases() {
    assertEquals(
      T3VoiceAudioRouteKind.SPEAKER,
      T3VoiceAudioRoutePolicy.normalize(T3VoiceAudioDeviceKind.BUILTIN_SPEAKER),
    )
    assertEquals(
      T3VoiceAudioRouteKind.EARPIECE,
      T3VoiceAudioRoutePolicy.normalize(T3VoiceAudioDeviceKind.BUILTIN_EARPIECE),
    )
    assertEquals(
      T3VoiceAudioRouteKind.WIRED,
      T3VoiceAudioRoutePolicy.normalize(T3VoiceAudioDeviceKind.WIRED),
    )
    assertNull(T3VoiceAudioRoutePolicy.normalize(T3VoiceAudioDeviceKind.UNKNOWN))
  }

  @Test
  fun preservesEveryAvailableExplicitRoute() {
    T3VoiceAudioRouteKind.entries
      .filterNot { it == T3VoiceAudioRouteKind.SYSTEM }
      .forEach { selected ->
        val result = T3VoiceAudioRoutePolicy.reconcile(selected, setOf(selected))
        assertEquals(selected, result.selected)
        assertNull(result.change)
      }
  }

  @Test
  fun fallsBackEveryUnavailableExplicitRouteToSystem() {
    T3VoiceAudioRouteKind.entries
      .filterNot { it == T3VoiceAudioRouteKind.SYSTEM }
      .forEach { selected ->
        val result = T3VoiceAudioRoutePolicy.reconcile(selected, emptySet())
        assertEquals(T3VoiceAudioRouteKind.SYSTEM, result.selected)
        assertEquals(
          T3VoiceAudioRouteChange(
            routeId = "system",
            routeType = "system",
            reason = T3VoiceAudioRouteChangeReason.SELECTED_ROUTE_UNAVAILABLE,
          ),
          result.change,
        )
      }
  }

  @Test
  fun systemSelectionNeverDependsOnEnumeratedDevices() {
    val result = T3VoiceAudioRoutePolicy.reconcile(T3VoiceAudioRouteKind.SYSTEM, emptySet())
    assertEquals(T3VoiceAudioRouteKind.SYSTEM, result.selected)
    assertNull(result.change)
  }

  @Test
  fun fallbackIsIdempotentAcrossRepeatedDeviceCallbacks() {
    val first = T3VoiceAudioRoutePolicy.reconcile(T3VoiceAudioRouteKind.BLUETOOTH, emptySet())
    val repeated = T3VoiceAudioRoutePolicy.reconcile(first.selected, emptySet())
    assertEquals(T3VoiceAudioRouteKind.SYSTEM, repeated.selected)
    assertNull(repeated.change)
  }

  @Test
  fun routeIdsRoundTripWithoutAliases() {
    T3VoiceAudioRouteKind.entries.forEach { route ->
      assertEquals(route, T3VoiceAudioRouteKind.fromId(route.id))
    }
    assertNull(T3VoiceAudioRouteKind.fromId("unknown"))
  }
}
