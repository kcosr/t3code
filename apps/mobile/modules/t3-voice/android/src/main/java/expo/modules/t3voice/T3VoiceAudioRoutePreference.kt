package expo.modules.t3voice

import android.content.Context

internal interface T3VoiceAudioRoutePreferenceStorage {
  fun read(): String?

  fun write(routeId: String)
}

internal class T3VoiceSharedPreferencesAudioRouteStorage(context: Context) :
  T3VoiceAudioRoutePreferenceStorage {
  private val preferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  override fun read(): String? = preferences.getString(PREFERRED_ROUTE_KEY, null)

  override fun write(routeId: String) {
    check(preferences.edit().putString(PREFERRED_ROUTE_KEY, routeId).commit()) {
      "Android could not persist the voice audio route preference."
    }
  }

  private companion object {
    const val PREFERENCES_NAME = "t3_voice_audio"
    const val PREFERRED_ROUTE_KEY = "preferred_route"
  }
}

internal class T3VoiceAudioRoutePreferenceStore(
  private val storage: T3VoiceAudioRoutePreferenceStorage,
) {
  @Synchronized
  fun get(): T3VoiceAudioRouteKind =
    storage.read()?.let(T3VoiceAudioRouteKind::fromId) ?: T3VoiceAudioRouteKind.SYSTEM

  @Synchronized
  fun set(route: T3VoiceAudioRouteKind) {
    storage.write(route.id)
  }
}

internal data class T3VoiceAudioRoutePreference(
  val preferredRouteId: String,
  val activeRouteId: String?,
  val routes: List<T3VoiceAudioRoute>,
) {
  fun toResultBody(): Map<String, Any?> =
    mapOf(
      "preferredRouteId" to preferredRouteId,
      "activeRouteId" to activeRouteId,
      "routes" to routes.map(T3VoiceAudioRoute::toResultBody),
    )
}
