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
  private var cached: T3VoiceAudioRouteKind? = null

  @Synchronized
  fun get(): T3VoiceAudioRouteKind =
    cached
      ?: (storage.read()?.let(T3VoiceAudioRouteKind::fromId) ?: T3VoiceAudioRouteKind.SYSTEM)
        .also { cached = it }

  @Synchronized
  fun set(route: T3VoiceAudioRouteKind) {
    if (route == get()) return
    storage.write(route.id)
    cached = route
  }
}

internal data class T3VoiceAudioRoutePreference(
  val preferredRoute: T3VoiceAudioRouteKind,
  val activeRoute: T3VoiceAudioRouteKind?,
  val routes: List<T3VoiceAudioRoute>,
) {
  fun toResultBody(): Map<String, Any?> =
    mapOf(
      "preferredRoute" to preferredRoute.id,
      "activeRoute" to activeRoute?.id,
      "routes" to routes.map(T3VoiceAudioRoute::toResultBody),
    )
}
