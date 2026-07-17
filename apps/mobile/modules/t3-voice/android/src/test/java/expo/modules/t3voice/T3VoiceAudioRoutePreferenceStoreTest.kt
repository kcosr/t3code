package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Test

class T3VoiceAudioRoutePreferenceStoreTest {
  @Test
  fun defaultsMissingPreferenceToSystem() {
    val store = T3VoiceAudioRoutePreferenceStore(FakeStorage())

    assertEquals(T3VoiceAudioRouteKind.SYSTEM, store.get())
  }

  @Test
  fun defaultsInvalidPersistedPreferenceToSystemWithoutAliases() {
    val store = T3VoiceAudioRoutePreferenceStore(FakeStorage("headset"))

    assertEquals(T3VoiceAudioRouteKind.SYSTEM, store.get())
  }

  @Test
  fun persistsEveryCanonicalRouteKind() {
    val storage = FakeStorage()
    val store = T3VoiceAudioRoutePreferenceStore(storage)

    T3VoiceAudioRouteKind.entries.forEach { route ->
      store.set(route)
      assertEquals(route.id, storage.value)
      assertEquals(route, store.get())
    }
  }

  private class FakeStorage(initialValue: String? = null) :
    T3VoiceAudioRoutePreferenceStorage {
    var value: String? = initialValue

    override fun read(): String? = value

    override fun write(routeId: String) {
      value = routeId
    }
  }
}

