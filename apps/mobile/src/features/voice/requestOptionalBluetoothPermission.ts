import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";

/** Bluetooth denial limits route discovery but does not block voice capture. */
export const requestOptionalBluetoothPermission = async (
  native: T3VoiceNativeModule,
): Promise<void> => {
  try {
    const current = await native.getBluetoothPermissionAsync();
    if (current.granted || current.canAskAgain === false) return;
    await native.requestBluetoothPermissionAsync();
  } catch {
    // Permission-manager failures have the same degraded behavior as denial.
  }
};
