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
  fun routeIdsRoundTripWithoutAliases() {
    assertEquals(
      listOf("system", "speaker", "earpiece", "bluetooth", "wired"),
      T3VoiceAudioRouteKind.entries.map(T3VoiceAudioRouteKind::id),
    )
    T3VoiceAudioRouteKind.entries.forEach { route ->
      assertEquals(route, T3VoiceAudioRouteKind.fromId(route.id))
    }
    assertNull(T3VoiceAudioRouteKind.fromId("unknown"))
  }
}
