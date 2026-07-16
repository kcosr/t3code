package expo.modules.t3voice.media

internal enum class T3VoiceAudioRouteKind(val id: String) {
  SYSTEM("system"),
  SPEAKER("speaker"),
  EARPIECE("earpiece"),
  WIRED("wired"),
  BLUETOOTH("bluetooth"),
  ;

  companion object {
    fun fromId(id: String): T3VoiceAudioRouteKind? = entries.firstOrNull { it.id == id }
  }
}

internal enum class T3VoiceAudioDeviceKind {
  BUILTIN_SPEAKER,
  BUILTIN_EARPIECE,
  WIRED,
  BLUETOOTH_CLASSIC,
  BLUETOOTH_LE_HEADSET,
  BLUETOOTH_LE_SPEAKER,
  UNKNOWN,
}

internal enum class T3VoiceAudioRouteChangeReason {
  SELECTED,
  SELECTED_ROUTE_UNAVAILABLE,
}

internal data class T3VoiceAudioRouteChange(
  val routeId: String,
  val routeType: String,
  val reason: T3VoiceAudioRouteChangeReason,
)

internal data class T3VoiceAudioRoutePolicyResult(
  val selected: T3VoiceAudioRouteKind,
  val change: T3VoiceAudioRouteChange?,
)

internal object T3VoiceAudioRoutePolicy {
  fun normalize(device: T3VoiceAudioDeviceKind): T3VoiceAudioRouteKind? =
    when (device) {
      T3VoiceAudioDeviceKind.BUILTIN_SPEAKER -> T3VoiceAudioRouteKind.SPEAKER
      T3VoiceAudioDeviceKind.BUILTIN_EARPIECE -> T3VoiceAudioRouteKind.EARPIECE
      T3VoiceAudioDeviceKind.WIRED -> T3VoiceAudioRouteKind.WIRED
      T3VoiceAudioDeviceKind.BLUETOOTH_CLASSIC,
      T3VoiceAudioDeviceKind.BLUETOOTH_LE_HEADSET,
      T3VoiceAudioDeviceKind.BLUETOOTH_LE_SPEAKER,
      -> T3VoiceAudioRouteKind.BLUETOOTH
      T3VoiceAudioDeviceKind.UNKNOWN -> null
    }

  fun reconcile(
    selected: T3VoiceAudioRouteKind,
    available: Set<T3VoiceAudioRouteKind>,
  ): T3VoiceAudioRoutePolicyResult {
    if (selected == T3VoiceAudioRouteKind.SYSTEM || selected in available) {
      return T3VoiceAudioRoutePolicyResult(selected, null)
    }
    return T3VoiceAudioRoutePolicyResult(
      selected = T3VoiceAudioRouteKind.SYSTEM,
      change =
        T3VoiceAudioRouteChange(
          routeId = T3VoiceAudioRouteKind.SYSTEM.id,
          routeType = T3VoiceAudioRouteKind.SYSTEM.id,
          reason = T3VoiceAudioRouteChangeReason.SELECTED_ROUTE_UNAVAILABLE,
        ),
    )
  }
}
