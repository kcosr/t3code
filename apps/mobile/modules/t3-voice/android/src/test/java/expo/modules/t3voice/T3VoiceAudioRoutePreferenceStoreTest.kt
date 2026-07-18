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
    val storage = FakeStorage("speaker")
    val store = T3VoiceAudioRoutePreferenceStore(storage)

    T3VoiceAudioRouteKind.entries.forEach { route ->
      store.set(route)
      assertEquals(route.id, storage.value)
      assertEquals(route, store.get())
    }
  }

  @Test
  fun repeatedSelectionDoesNotRewritePreference() {
    val storage = FakeStorage("bluetooth")
    val store = T3VoiceAudioRoutePreferenceStore(storage)

    store.set(T3VoiceAudioRouteKind.BLUETOOTH)
    store.set(T3VoiceAudioRouteKind.BLUETOOTH)

    assertEquals(0, storage.writeCount)
  }

  @Test
  fun preferenceBridgeBodyUsesOneCanonicalRouteField() {
    assertEquals(
      mapOf(
        "preferredRoute" to "bluetooth",
        "activeRoute" to "system",
        "routes" to
          listOf(
            mapOf("kind" to "system", "label" to "System default"),
            mapOf("kind" to "bluetooth", "label" to "Headphones"),
          ),
      ),
      T3VoiceAudioRoutePreference(
          preferredRoute = T3VoiceAudioRouteKind.BLUETOOTH,
          activeRoute = T3VoiceAudioRouteKind.SYSTEM,
          routes =
            listOf(
              T3VoiceAudioRoute(T3VoiceAudioRouteKind.SYSTEM, "System default"),
              T3VoiceAudioRoute(T3VoiceAudioRouteKind.BLUETOOTH, "Headphones"),
            ),
        )
        .toResultBody(),
    )
  }

  private class FakeStorage(initialValue: String? = null) :
    T3VoiceAudioRoutePreferenceStorage {
    var value: String? = initialValue
    var writeCount = 0

    override fun read(): String? = value

    override fun write(routeId: String) {
      writeCount += 1
      value = routeId
    }
  }
}
