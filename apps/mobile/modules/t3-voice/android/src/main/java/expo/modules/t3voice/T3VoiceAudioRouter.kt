package expo.modules.t3voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

internal data class T3VoiceAudioRoute(
  val id: String,
  val label: String,
  val type: String,
  val selected: Boolean,
) {
  fun toResultBody(): Map<String, Any> =
    mapOf(
      "id" to id,
      "label" to label,
      "type" to type,
      "selected" to selected,
    )
}

internal class T3VoiceAudioRouter(context: Context) {
  private val audioManager = context.getSystemService(AudioManager::class.java)
  private var focusRequest: AudioFocusRequest? = null
  private var active = false

  fun start() {
    if (active) return
    active = true
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    requestFocus()
  }

  fun stop() {
    if (!active) return
    clearSelectedRoute()
    abandonFocus()
    audioManager.mode = AudioManager.MODE_NORMAL
    active = false
  }

  fun routes(): List<T3VoiceAudioRoute> {
    val selectedId = selectedRouteId()
    val routes = mutableListOf(
      T3VoiceAudioRoute(
        id = ROUTE_SYSTEM,
        label = "System default",
        type = "system",
        selected = selectedId == ROUTE_SYSTEM,
      ),
    )
    availableOutputDevices()
      .groupBy(::routeIdForDevice)
      .forEach { (routeId, devices) ->
        if (routeId == null) return@forEach
        val device = devices.first()
        routes +=
          T3VoiceAudioRoute(
            id = routeId,
            label = routeLabel(routeId, device),
            type = routeId,
            selected = selectedId == routeId,
          )
      }
    return routes
  }

  fun select(routeId: String) {
    check(active) { "An active Realtime session is required to select an audio route." }
    require(routeId in ROUTE_IDS) { "Unsupported audio route." }
    if (routeId == ROUTE_SYSTEM) {
      clearSelectedRoute()
      return
    }
    val device = availableOutputDevices().firstOrNull { routeIdForDevice(it) == routeId }
      ?: error("The requested audio route is unavailable.")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      check(audioManager.setCommunicationDevice(device)) {
        "Android could not select the requested audio route."
      }
      return
    }
    selectLegacyRoute(routeId)
  }

  @Suppress("DEPRECATION")
  private fun clearSelectedRoute() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.clearCommunicationDevice()
    } else {
      audioManager.stopBluetoothSco()
      audioManager.isBluetoothScoOn = false
      audioManager.isSpeakerphoneOn = false
    }
  }

  @Suppress("DEPRECATION")
  private fun selectLegacyRoute(routeId: String) {
    when (routeId) {
      ROUTE_SPEAKER -> {
        audioManager.stopBluetoothSco()
        audioManager.isBluetoothScoOn = false
        audioManager.isSpeakerphoneOn = true
      }
      ROUTE_BLUETOOTH -> {
        audioManager.isSpeakerphoneOn = false
        audioManager.startBluetoothSco()
        audioManager.isBluetoothScoOn = true
      }
      ROUTE_EARPIECE, ROUTE_WIRED -> {
        audioManager.stopBluetoothSco()
        audioManager.isBluetoothScoOn = false
        audioManager.isSpeakerphoneOn = false
      }
    }
  }

  private fun selectedRouteId(): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return audioManager.communicationDevice?.let(::routeIdForDevice) ?: ROUTE_SYSTEM
    }
    @Suppress("DEPRECATION")
    return when {
      audioManager.isBluetoothScoOn -> ROUTE_BLUETOOTH
      audioManager.isSpeakerphoneOn -> ROUTE_SPEAKER
      else -> ROUTE_SYSTEM
    }
  }

  @SuppressLint("MissingPermission")
  private fun availableOutputDevices(): List<AudioDeviceInfo> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audioManager.availableCommunicationDevices
    } else {
      audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
    }

  private fun routeIdForDevice(device: AudioDeviceInfo): String? =
    when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> ROUTE_SPEAKER
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> ROUTE_EARPIECE
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> ROUTE_BLUETOOTH
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      -> ROUTE_WIRED
      else -> null
    }

  private fun routeLabel(routeId: String, device: AudioDeviceInfo): String =
    when (routeId) {
      ROUTE_SPEAKER -> "Speaker"
      ROUTE_EARPIECE -> "Phone"
      ROUTE_BLUETOOTH -> device.productName.toString().ifBlank { "Bluetooth" }
      ROUTE_WIRED -> device.productName.toString().ifBlank { "Wired headset" }
      else -> "System default"
    }

  private fun requestFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build(),
          )
          .setOnAudioFocusChangeListener { }
          .build()
      focusRequest = request
      audioManager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        null,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
      )
    }
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let(audioManager::abandonAudioFocusRequest)
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(null)
    }
  }

  companion object {
    private const val ROUTE_SYSTEM = "system"
    private const val ROUTE_SPEAKER = "speaker"
    private const val ROUTE_EARPIECE = "earpiece"
    private const val ROUTE_WIRED = "wired"
    private const val ROUTE_BLUETOOTH = "bluetooth"
    private val ROUTE_IDS =
      setOf(ROUTE_SYSTEM, ROUTE_SPEAKER, ROUTE_EARPIECE, ROUTE_WIRED, ROUTE_BLUETOOTH)
  }
}
