package expo.modules.t3voice.media

import expo.modules.t3voice.kernel.T3VoiceDiagnosticCategory
import expo.modules.t3voice.kernel.T3VoiceDiagnosticCode
import expo.modules.t3voice.kernel.T3VoiceDiagnostics
import expo.modules.t3voice.kernel.VoiceKernelEpoch

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
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

internal data class T3VoiceAudioRouterStartResult(
  val transition: T3VoiceAudioFocusTransition,
)

internal class T3VoiceAudioRouter(
  context: Context,
  private val onFocusChanged: (VoiceKernelEpoch, String, Int) -> Unit = { _, _, _ -> },
  private val onAudioDevicesChanged: (VoiceKernelEpoch, String) -> Unit = { _, _ -> },
  private val onRouteChanged: (VoiceKernelEpoch, String, T3VoiceAudioRouteChange) -> Unit =
    { _, _, _ -> },
) {
  private val audioManager = context.getSystemService(AudioManager::class.java)
  private var focusRequest: AudioFocusRequest? = null
  private var focusState = T3VoiceAudioFocusState.TERMINATED
  private var selectedRoute = T3VoiceAudioRouteKind.SYSTEM
  private var deviceCallbackRegistered = false
  private var active = false
  private var activeEpoch: VoiceKernelEpoch? = null
  private var generation = 0L
  private var focusChangeListener: AudioManager.OnAudioFocusChangeListener? = null
  private var deviceCallback: AudioDeviceCallback? = null

  @Synchronized
  fun start(ownerId: String, epoch: VoiceKernelEpoch): T3VoiceAudioRouterStartResult {
    require(ownerId.isNotBlank()) { "Audio route owner must be non-empty." }
    require(epoch.rootOperationId == ownerId) { "Audio route epoch must belong to its owner." }
    if (active) {
      return T3VoiceAudioRouterStartResult(
        transition = T3VoiceAudioFocusTransition(focusState, emptyList()),
      )
    }
    val diagnosticGeneration = T3VoiceDiagnostics.nextGeneration()
    generation = diagnosticGeneration
    recordDiagnostic(T3VoiceDiagnosticCategory.LIFECYCLE, T3VoiceDiagnosticCode.STARTED)
    focusChangeListener =
      AudioManager.OnAudioFocusChangeListener { change ->
        onFocusChanged(epoch, ownerId, change)
      }
    deviceCallback =
      object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
          onAudioDevicesChanged(epoch, ownerId)
        }

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
          onAudioDevicesChanged(epoch, ownerId)
        }
      }
    active = true
    activeEpoch = epoch
    focusState = T3VoiceAudioFocusState.ACTIVE
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    if (requestFocus()) {
      recordDiagnostic(T3VoiceDiagnosticCategory.FOCUS, T3VoiceDiagnosticCode.REQUEST_GRANTED)
      registerDeviceCallback()
      return T3VoiceAudioRouterStartResult(
        transition = T3VoiceAudioFocusTransition(focusState, emptyList()),
      )
    }
    return T3VoiceAudioRouterStartResult(
      transition = applyFocusEvent(T3VoiceAudioFocusEvent.REQUEST_DENIED),
    )
  }

  @Synchronized
  fun stop(): Boolean {
    if (!active) return false
    recordDiagnostic(T3VoiceDiagnosticCategory.LIFECYCLE, T3VoiceDiagnosticCode.STOPPED)
    unregisterDeviceCallback()
    active = false
    activeEpoch = null
    focusState = T3VoiceAudioFocusState.TERMINATED
    selectedRoute = T3VoiceAudioRouteKind.SYSTEM
    runCatching(::clearSelectedRoute)
    runCatching(::abandonFocus)
    runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
    return true
  }

  @Synchronized
  fun routes(): List<T3VoiceAudioRoute> {
    val selectedId = selectedRoute.id
    val routes = mutableListOf(
      T3VoiceAudioRoute(
        id = T3VoiceAudioRouteKind.SYSTEM.id,
        label = "System default",
        type = T3VoiceAudioRouteKind.SYSTEM.id,
        selected = selectedId == T3VoiceAudioRouteKind.SYSTEM.id,
      ),
    )
    availableOutputDevicesOrNull().orEmpty()
      .groupBy(::routeIdForDevice)
      .forEach { (routeId, devices) ->
        if (routeId == null) return@forEach
        val device = devices.first()
        routes +=
          T3VoiceAudioRoute(
            id = routeId.id,
            label = routeLabel(routeId, device),
            type = routeId.id,
            selected = selectedId == routeId.id,
          )
      }
    return routes
  }

  @Synchronized
  fun select(routeId: String) {
    check(active) { "An active Realtime session is required to select an audio route." }
    val route = requireNotNull(T3VoiceAudioRouteKind.fromId(routeId)) { "Unsupported audio route." }
    if (route == T3VoiceAudioRouteKind.SYSTEM) {
      clearSelectedRoute()
    } else {
      val devices =
        availableOutputDevicesOrNull() ?: error("Android audio routes are unavailable.")
      val device =
        devices.firstOrNull { routeIdForDevice(it) == route }
          ?: error("The requested audio route is unavailable.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        check(audioManager.setCommunicationDevice(device)) {
          "Android could not select the requested audio route."
        }
      } else {
        selectLegacyRoute(route)
      }
    }
    selectedRoute = route
    recordDiagnostic(T3VoiceDiagnosticCategory.ROUTE, T3VoiceDiagnosticCode.ROUTE_SELECTED)
    val epoch = checkNotNull(activeEpoch)
    onRouteChanged(
      epoch,
      epoch.rootOperationId,
      T3VoiceAudioRouteChange(
        routeId = route.id,
        routeType = route.id,
        reason = T3VoiceAudioRouteChangeReason.SELECTED,
      ),
    )
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

  private fun routeLabel(route: T3VoiceAudioRouteKind, device: AudioDeviceInfo): String =
    when (route) {
      T3VoiceAudioRouteKind.SPEAKER -> "Speaker"
      T3VoiceAudioRouteKind.EARPIECE -> "Phone"
      T3VoiceAudioRouteKind.BLUETOOTH -> device.productName.toString().ifBlank { "Bluetooth" }
      T3VoiceAudioRouteKind.WIRED -> device.productName.toString().ifBlank { "Wired headset" }
      T3VoiceAudioRouteKind.SYSTEM -> "System default"
    }

  private fun requestFocus(): Boolean {
    val listener = checkNotNull(focusChangeListener)
    val result =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val request =
          AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
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
          AudioManager.STREAM_VOICE_CALL,
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
  fun handleAudioFocusChange(change: Int): T3VoiceAudioFocusTransition {
    if (!active) return T3VoiceAudioFocusTransition(focusState, emptyList())
    val event =
      when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> T3VoiceAudioFocusEvent.GAINED
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> T3VoiceAudioFocusEvent.LOST_TRANSIENTLY
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> T3VoiceAudioFocusEvent.DUCK_REQUESTED
        AudioManager.AUDIOFOCUS_LOSS -> T3VoiceAudioFocusEvent.LOST_PERMANENTLY
        else -> return T3VoiceAudioFocusTransition(focusState, emptyList())
      }
    return applyFocusEvent(event)
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
    return transition
  }

  private fun releaseAudioOwnership() {
    if (!active) return
    active = false
    activeEpoch = null
    unregisterDeviceCallback()
    selectedRoute = T3VoiceAudioRouteKind.SYSTEM
    runCatching(::clearSelectedRoute)
    runCatching(::abandonFocus)
    runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
  }

  private fun registerDeviceCallback() {
    if (deviceCallbackRegistered) return
    val callback = deviceCallback ?: return
    val registered = runCatching { audioManager.registerAudioDeviceCallback(callback, null) }
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
    val callback = deviceCallback
    deviceCallback = null
    if (!deviceCallbackRegistered || callback == null) return
    deviceCallbackRegistered = false
    runCatching { audioManager.unregisterAudioDeviceCallback(callback) }
    recordDiagnostic(
      T3VoiceDiagnosticCategory.ROUTE,
      T3VoiceDiagnosticCode.DEVICE_CALLBACK_UNREGISTERED,
    )
  }

  @Synchronized
  fun reconcileSelectedRoute(): T3VoiceAudioRouteChange? {
    if (!active) return null
    val availableDevices =
      availableOutputDevicesOrNull()
        ?: run {
          recordDiagnostic(
            T3VoiceDiagnosticCategory.ROUTE,
            T3VoiceDiagnosticCode.ROUTE_SCAN_UNAVAILABLE,
          )
          return null
        }
    val availableRoutes = availableDevices.mapNotNull(::routeIdForDevice).toSet()
    val result = T3VoiceAudioRoutePolicy.reconcile(selectedRoute, availableRoutes)
    val change = result.change ?: return null
    if (runCatching(::clearSelectedRoute).isFailure) {
      recordDiagnostic(
        T3VoiceDiagnosticCategory.ROUTE,
        T3VoiceDiagnosticCode.ROUTE_SCAN_UNAVAILABLE,
      )
      return null
    }
    selectedRoute = result.selected
    recordDiagnostic(
      T3VoiceDiagnosticCategory.ROUTE,
      T3VoiceDiagnosticCode.ROUTE_FALLBACK,
      primaryCount = availableRoutes.size,
    )
    return change
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
}
