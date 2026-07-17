import * as Notifications from "expo-notifications";

export const ANDROID_VOICE_NOTIFICATION_CHANNEL_ID = "t3_voice_runtime";

export interface AndroidVoiceNotificationPermissionApi {
  readonly prepareChannel: () => Promise<void>;
  readonly getPermissions: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly requestPermissions: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
}

const liveApi: AndroidVoiceNotificationPermissionApi = {
  prepareChannel: async () => {
    await Notifications.setNotificationChannelAsync(ANDROID_VOICE_NOTIFICATION_CHANNEL_ID, {
      name: "T3 voice",
      description: "Active T3 voice sessions",
      importance: Notifications.AndroidImportance.LOW,
      sound: null,
      enableVibrate: false,
    });
  },
  getPermissions: () => Notifications.getPermissionsAsync(),
  requestPermissions: () => Notifications.requestPermissionsAsync(),
};

/**
 * Prepares Android's voice channel before requesting notification access.
 * A user denial reduces drawer controls but intentionally does not block the
 * foreground voice operation.
 */
export async function requestAndroidVoiceNotificationPermission(
  api: AndroidVoiceNotificationPermissionApi = liveApi,
): Promise<"granted" | "denied"> {
  try {
    await api.prepareChannel();
    const current = await api.getPermissions();
    if (current.granted) return "granted";
    if (!current.canAskAgain) return "denied";
    return (await api.requestPermissions()).granted ? "granted" : "denied";
  } catch {
    return "denied";
  }
}
