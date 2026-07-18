package expo.modules.t3voice

internal enum class T3VoiceAudioRouteKind(val id: String) {
  SYSTEM("system"),
  SPEAKER("speaker"),
  EARPIECE("earpiece"),
  BLUETOOTH("bluetooth"),
  WIRED("wired"),
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
}
