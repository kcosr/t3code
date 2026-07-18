package expo.modules.t3voice

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

internal data class T3VoiceAudioRoute(
  val kind: T3VoiceAudioRouteKind,
  val label: String,
) {
  fun toResultBody(): Map<String, Any> =
    mapOf(
      "kind" to kind.id,
      "label" to label,
    )
}

internal data class T3VoiceAudioRouterStartResult(
  val transition: T3VoiceAudioFocusTransition,
  val ownerGeneration: Long,
)

private enum class T3VoiceAudioRole {
  COMMUNICATION,
  PLAYBACK,
}

/** The narrow Realtime-session view of the process-owned Android audio router. */
internal interface T3VoiceRealtimeAudioRouting {
  fun stop()
}

internal class T3VoiceAudioRouter(
  context: Context,
  private val onFocusActions: (List<T3VoiceAudioFocusAction>) -> Unit = {},
  private val onPreferenceChanged: (T3VoiceAudioRoutePreference) -> Unit = {},
) : T3VoiceRealtimeAudioRouting {
  private val audioManager = context.getSystemService(AudioManager::class.java)
  private val preferenceStore =
    T3VoiceAudioRoutePreferenceStore(T3VoiceSharedPreferencesAudioRouteStorage(context))
  private var focusRequest: AudioFocusRequest? = null
  private var focusState = T3VoiceAudioFocusState.TERMINATED
  private var preferredRoute = preferenceStore.get()
  private var activeRoute: T3VoiceAudioRouteKind? = null
  private var availableRoutes =
    listOf(T3VoiceAudioRoute(T3VoiceAudioRouteKind.SYSTEM, routeLabel(T3VoiceAudioRouteKind.SYSTEM)))
  private var lastPublishedPreference: T3VoiceAudioRoutePreference? = null
  private var deviceCallbackRegistered = false
  private var active = false
  private var activeRole: T3VoiceAudioRole? = null
  private var generation = 0L
  private var activeGeneration: Long? = null
  private var focusChangeListener: AudioManager.OnAudioFocusChangeListener? = null
  private val deviceCallback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
        onAvailableDevicesChanged()
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
        onAvailableDevicesChanged()
      }
    }

  init {
    refreshAvailableRoutes(availableOutputDevicesOrNull())
    lastPublishedPreference = preference()
    registerDeviceCallback()
  }

  @Synchronized
  fun startCommunication(): T3VoiceAudioRouterStartResult = start(T3VoiceAudioRole.COMMUNICATION)

  @Synchronized
  fun startPlayback(): T3VoiceAudioRouterStartResult = start(T3VoiceAudioRole.PLAYBACK)

  @Synchronized
  private fun start(role: T3VoiceAudioRole): T3VoiceAudioRouterStartResult {
    if (active) {
      check(activeRole == role) { "Android audio is already owned by a different voice role." }
      return T3VoiceAudioRouterStartResult(
        transition = T3VoiceAudioFocusTransition(focusState, emptyList()),
        ownerGeneration = checkNotNull(activeGeneration),
      )
    }
    val ownerGeneration = T3VoiceDiagnostics.nextGeneration()
    generation = ownerGeneration
    activeGeneration = ownerGeneration
    recordDiagnostic(T3VoiceDiagnosticCategory.LIFECYCLE, T3VoiceDiagnosticCode.STARTED)
    focusChangeListener =
      AudioManager.OnAudioFocusChangeListener { change ->
        onAudioFocusChanged(ownerGeneration, change)
    }
    active = true
    activeRole = role
    focusState = T3VoiceAudioFocusState.ACTIVE
    if (role == T3VoiceAudioRole.COMMUNICATION) {
      audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    } else {
      runCatching(::clearSelectedRoute)
      audioManager.mode = AudioManager.MODE_NORMAL
    }
    if (requestFocus(role)) {
      recordDiagnostic(T3VoiceDiagnosticCategory.FOCUS, T3VoiceDiagnosticCode.REQUEST_GRANTED)
      if (role == T3VoiceAudioRole.COMMUNICATION) {
        applyPreferredRoute(ownerGeneration)
      } else {
        updatePlaybackRoute()
      }
      return T3VoiceAudioRouterStartResult(
        transition = T3VoiceAudioFocusTransition(focusState, emptyList()),
        ownerGeneration = ownerGeneration,
      )
    }
    return T3VoiceAudioRouterStartResult(
      transition = applyFocusEvent(T3VoiceAudioFocusEvent.REQUEST_DENIED),
      ownerGeneration = ownerGeneration,
    )
  }

  @Synchronized
  override fun stop() {
    if (!active) return
    recordDiagnostic(T3VoiceDiagnosticCategory.LIFECYCLE, T3VoiceDiagnosticCode.STOPPED)
    active = false
    activeRole = null
    activeGeneration = null
    focusState = T3VoiceAudioFocusState.TERMINATED
    activeRoute = null
    runCatching(::clearSelectedRoute)
    runCatching(::abandonFocus)
    runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
    publishPreference()
  }

  @Synchronized
  fun preference(): T3VoiceAudioRoutePreference =
    T3VoiceAudioRoutePreference(
      preferredRoute = preferredRoute,
      activeRoute = activeRoute,
      routes = availableRoutes,
    )

  @Synchronized
  fun setPreference(routeValue: String): T3VoiceAudioRoutePreference {
    val route = requireNotNull(T3VoiceAudioRouteKind.fromId(routeValue)) { "Unsupported audio route." }
    if (preferredRoute == route) {
      val ownerGeneration = activeGeneration
      if (ownerGeneration != null && activeRoute != preferredRoute) {
        if (activeRole == T3VoiceAudioRole.COMMUNICATION) {
          applyPreferredRoute(ownerGeneration)
        } else {
          updatePlaybackRoute()
        }
      }
      return preference()
    }
    preferenceStore.set(route)
    preferredRoute = route
    val ownerGeneration = activeGeneration
    when {
      ownerGeneration == null -> publishPreference()
      activeRole == T3VoiceAudioRole.COMMUNICATION -> applyPreferredRoute(ownerGeneration)
      else -> updatePlaybackRoute()
    }
    return preference()
  }

  @Synchronized
  fun preferredPlaybackDevice(): AudioDeviceInfo? = resolvePlaybackRoute().second

  @Synchronized
  fun shutdown() {
    stop()
    unregisterDeviceCallback()
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
  private fun selectLegacyRoute(route: T3VoiceAudioRouteKind) {
    when (route) {
      T3VoiceAudioRouteKind.SPEAKER -> {
        audioManager.stopBluetoothSco()
        audioManager.isBluetoothScoOn = false
        audioManager.isSpeakerphoneOn = true
      }
      T3VoiceAudioRouteKind.BLUETOOTH -> {
        audioManager.isSpeakerphoneOn = false
        audioManager.startBluetoothSco()
        audioManager.isBluetoothScoOn = true
      }
      T3VoiceAudioRouteKind.EARPIECE, T3VoiceAudioRouteKind.WIRED -> {
        audioManager.stopBluetoothSco()
        audioManager.isBluetoothScoOn = false
        audioManager.isSpeakerphoneOn = false
      }
      T3VoiceAudioRouteKind.SYSTEM -> clearSelectedRoute()
    }
  }

  @SuppressLint("MissingPermission")
  private fun availableOutputDevicesOrNull(): List<AudioDeviceInfo>? =
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        audioManager.availableCommunicationDevices
      } else {
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
      }
    }.getOrNull()

  private fun routeIdForDevice(device: AudioDeviceInfo): T3VoiceAudioRouteKind? =
    T3VoiceAudioRoutePolicy.normalize(deviceKind(device))

  private fun deviceKind(device: AudioDeviceInfo): T3VoiceAudioDeviceKind =
    when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> T3VoiceAudioDeviceKind.BUILTIN_SPEAKER
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> T3VoiceAudioDeviceKind.BUILTIN_EARPIECE
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> T3VoiceAudioDeviceKind.BLUETOOTH_CLASSIC
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      -> T3VoiceAudioDeviceKind.WIRED
      else ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          modernDeviceKind(device)
        } else {
          T3VoiceAudioDeviceKind.UNKNOWN
        }
    }

  @android.annotation.TargetApi(Build.VERSION_CODES.S)
  private fun modernDeviceKind(device: AudioDeviceInfo): T3VoiceAudioDeviceKind =
    when (device.type) {
      AudioDeviceInfo.TYPE_BLE_HEADSET -> T3VoiceAudioDeviceKind.BLUETOOTH_LE_HEADSET
      AudioDeviceInfo.TYPE_BLE_SPEAKER -> T3VoiceAudioDeviceKind.BLUETOOTH_LE_SPEAKER
      else -> T3VoiceAudioDeviceKind.UNKNOWN
    }

  private fun routeLabel(route: T3VoiceAudioRouteKind, device: AudioDeviceInfo? = null): String =
    when (route) {
      T3VoiceAudioRouteKind.SPEAKER -> "Speaker"
      T3VoiceAudioRouteKind.EARPIECE -> "Phone"
      T3VoiceAudioRouteKind.BLUETOOTH ->
        device?.productName?.toString()?.ifBlank { "Bluetooth" } ?: "Bluetooth"
      T3VoiceAudioRouteKind.WIRED ->
        device?.productName?.toString()?.ifBlank { "Wired headset" } ?: "Wired headset"
      T3VoiceAudioRouteKind.SYSTEM -> "System default"
    }

  private fun requestFocus(role: T3VoiceAudioRole): Boolean {
    val listener = checkNotNull(focusChangeListener)
    val usage =
      if (role == T3VoiceAudioRole.PLAYBACK) {
        AudioAttributes.USAGE_MEDIA
      } else {
        AudioAttributes.USAGE_VOICE_COMMUNICATION
      }
    val result =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request =
          AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(usage)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            )
            .setOnAudioFocusChangeListener(listener)
            .build()
        focusRequest = request
        audioManager.requestAudioFocus(request)
      } else {
        @Suppress("DEPRECATION")
        audioManager.requestAudioFocus(
          listener,
          if (role == T3VoiceAudioRole.PLAYBACK) {
            AudioManager.STREAM_MUSIC
          } else {
            AudioManager.STREAM_VOICE_CALL
          },
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
        )
      }
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    val listener = focusChangeListener
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let(audioManager::abandonAudioFocusRequest)
      focusRequest = null
    } else if (listener != null) {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(listener)
    }
    focusChangeListener = null
  }

  @Synchronized
  private fun onAudioFocusChanged(ownerGeneration: Long, change: Int) {
    if (!active || activeGeneration != ownerGeneration) return
    val event =
      when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> T3VoiceAudioFocusEvent.GAINED
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> T3VoiceAudioFocusEvent.LOST_TRANSIENTLY
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> T3VoiceAudioFocusEvent.DUCK_REQUESTED
        AudioManager.AUDIOFOCUS_LOSS -> T3VoiceAudioFocusEvent.LOST_PERMANENTLY
        else -> return
      }
    applyFocusEvent(event)
  }

  private fun applyFocusEvent(event: T3VoiceAudioFocusEvent): T3VoiceAudioFocusTransition {
    recordDiagnostic(
      T3VoiceDiagnosticCategory.FOCUS,
      when (event) {
        T3VoiceAudioFocusEvent.GAINED -> T3VoiceDiagnosticCode.GAINED
        T3VoiceAudioFocusEvent.LOST_TRANSIENTLY -> T3VoiceDiagnosticCode.LOST_TRANSIENTLY
        T3VoiceAudioFocusEvent.DUCK_REQUESTED -> T3VoiceDiagnosticCode.DUCK_REQUESTED
        T3VoiceAudioFocusEvent.LOST_PERMANENTLY -> T3VoiceDiagnosticCode.LOST_PERMANENTLY
        T3VoiceAudioFocusEvent.REQUEST_DENIED -> T3VoiceDiagnosticCode.REQUEST_DENIED
      },
    )
    val transition = T3VoiceAudioFocusPolicy.reduce(focusState, event)
    focusState = transition.state
    if (transition.state == T3VoiceAudioFocusState.TERMINATED) {
      releaseAudioOwnership()
    }
    if (transition.actions.isNotEmpty()) onFocusActions(transition.actions)
    return transition
  }

  private fun releaseAudioOwnership() {
    if (!active) return
    active = false
    activeRole = null
    activeGeneration = null
    activeRoute = null
    runCatching(::clearSelectedRoute)
    runCatching(::abandonFocus)
    runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
    publishPreference()
  }

  private fun registerDeviceCallback() {
    if (deviceCallbackRegistered) return
    val registered = runCatching { audioManager.registerAudioDeviceCallback(deviceCallback, null) }
    if (registered.isSuccess) {
      deviceCallbackRegistered = true
      recordDiagnostic(
        T3VoiceDiagnosticCategory.ROUTE,
        T3VoiceDiagnosticCode.DEVICE_CALLBACK_REGISTERED,
      )
    } else {
      recordDiagnostic(
        T3VoiceDiagnosticCategory.ROUTE,
        T3VoiceDiagnosticCode.DEVICE_CALLBACK_UNAVAILABLE,
      )
    }
  }

  private fun unregisterDeviceCallback() {
    if (!deviceCallbackRegistered) return
    deviceCallbackRegistered = false
    runCatching { audioManager.unregisterAudioDeviceCallback(deviceCallback) }
    recordDiagnostic(
      T3VoiceDiagnosticCategory.ROUTE,
      T3VoiceDiagnosticCode.DEVICE_CALLBACK_UNREGISTERED,
    )
  }

  @Synchronized
  private fun onAvailableDevicesChanged() {
    val ownerGeneration = activeGeneration
    if (ownerGeneration != null && activeRole == T3VoiceAudioRole.COMMUNICATION) {
      applyPreferredRoute(ownerGeneration)
    } else if (ownerGeneration != null) {
      refreshAvailableRoutes(availableOutputDevicesOrNull())
      updatePlaybackRoute()
    } else {
      refreshAvailableRoutes(availableOutputDevicesOrNull())
      publishPreference()
    }
  }

  private fun applyPreferredRoute(ownerGeneration: Long) {
    if (!active || activeGeneration != ownerGeneration) return
    val availableDevices = availableOutputDevicesOrNull()
    if (availableDevices == null) {
      refreshAvailableRoutes(null)
      runCatching(::clearSelectedRoute)
      activeRoute = T3VoiceAudioRouteKind.SYSTEM
      recordDiagnostic(
        T3VoiceDiagnosticCategory.ROUTE,
        T3VoiceDiagnosticCode.ROUTE_SCAN_UNAVAILABLE,
      )
      publishPreference()
      return
    }
    refreshAvailableRoutes(availableDevices)
    val selectedDevice =
      if (preferredRoute == T3VoiceAudioRouteKind.SYSTEM) {
        null
      } else {
        availableDevices.firstOrNull { routeIdForDevice(it) == preferredRoute }
      }
    val requestedActiveRoute =
      if (preferredRoute == T3VoiceAudioRouteKind.SYSTEM || selectedDevice != null) {
        preferredRoute
      } else {
        T3VoiceAudioRouteKind.SYSTEM
      }
    val requestedRouteApplied =
      runCatching {
        if (requestedActiveRoute == T3VoiceAudioRouteKind.SYSTEM) {
          clearSelectedRoute()
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          check(audioManager.setCommunicationDevice(checkNotNull(selectedDevice))) {
            "Android could not select the requested audio route."
          }
        } else {
          selectLegacyRoute(requestedActiveRoute)
        }
      }
    val appliedRoute =
      if (requestedRouteApplied.isSuccess) {
        requestedActiveRoute
      } else if (
        requestedActiveRoute != T3VoiceAudioRouteKind.SYSTEM &&
          runCatching(::clearSelectedRoute).isSuccess
      ) {
        T3VoiceAudioRouteKind.SYSTEM
      } else {
        recordDiagnostic(
          T3VoiceDiagnosticCategory.ROUTE,
          T3VoiceDiagnosticCode.ROUTE_SCAN_UNAVAILABLE,
        )
        publishPreference()
        return
      }
    if (activeRoute == appliedRoute) {
      publishPreference()
      return
    }
    activeRoute = appliedRoute
    val fallback = appliedRoute != preferredRoute
    recordDiagnostic(
      T3VoiceDiagnosticCategory.ROUTE,
      if (fallback) T3VoiceDiagnosticCode.ROUTE_FALLBACK else T3VoiceDiagnosticCode.ROUTE_SELECTED,
      primaryCount = availableDevices.size,
    )
    publishPreference()
  }

  private fun refreshAvailableRoutes(devices: List<AudioDeviceInfo>?) {
    val devicesByRoute =
      devices.orEmpty()
        .mapNotNull { device -> routeIdForDevice(device)?.let { route -> route to device } }
        .groupBy({ it.first }, { it.second })
    availableRoutes =
      T3VoiceAudioRouteKind.entries.mapNotNull { route ->
        val device = devicesByRoute[route]?.firstOrNull()
        if (route != T3VoiceAudioRouteKind.SYSTEM && device == null) return@mapNotNull null
        T3VoiceAudioRoute(route, routeLabel(route, device))
      }
  }

  private fun publishPreference() {
    val preference = preference()
    if (preference == lastPublishedPreference) return
    lastPublishedPreference = preference
    onPreferenceChanged(preference)
  }

  private fun recordDiagnostic(
    category: T3VoiceDiagnosticCategory,
    code: T3VoiceDiagnosticCode,
    primaryCount: Int = 0,
    secondaryCount: Int = 0,
  ) {
    T3VoiceDiagnostics.record(
      generation,
      category,
      code,
      primaryCount,
      secondaryCount,
    )
  }

  private fun updatePlaybackRoute() {
    val (route, _) = resolvePlaybackRoute()
    activeRoute = route
    publishPreference()
  }

  private fun resolvePlaybackRoute(): Pair<T3VoiceAudioRouteKind, AudioDeviceInfo?> {
    if (preferredRoute == T3VoiceAudioRouteKind.SYSTEM) {
      return T3VoiceAudioRouteKind.SYSTEM to null
    }
    val outputs =
      runCatching { audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList() }
        .getOrNull()
        ?: return T3VoiceAudioRouteKind.SYSTEM to null
    val selected =
      outputs
        .filter { playbackRouteKind(it) == preferredRoute }
        .minByOrNull(::playbackDevicePriority)
    return if (selected == null) {
      T3VoiceAudioRouteKind.SYSTEM to null
    } else {
      preferredRoute to selected
    }
  }

  private fun playbackRouteKind(device: AudioDeviceInfo): T3VoiceAudioRouteKind? =
    when (device.type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> T3VoiceAudioRouteKind.SPEAKER
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> T3VoiceAudioRouteKind.EARPIECE
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      -> T3VoiceAudioRouteKind.BLUETOOTH
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      -> T3VoiceAudioRouteKind.WIRED
      else -> null
    }

  private fun playbackDevicePriority(device: AudioDeviceInfo): Int =
    when (device.type) {
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      -> 0
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 1
      else -> 0
    }
}
