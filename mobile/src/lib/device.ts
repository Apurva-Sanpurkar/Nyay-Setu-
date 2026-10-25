import * as FileSystem from "expo-file-system";
import * as Crypto from "expo-crypto";

/**
 * A random identifier for this installation, recorded in every capture
 * manifest. It is not derived from the hardware or any account, so it identifies
 * an install, not a person; reinstalling the app produces a new one.
 */
const PATH = `${FileSystem.documentDirectory}device-id`;
let cached: string | null = null;

export async function deviceId(): Promise<string> {
  if (cached) return cached;
  const info = await FileSystem.getInfoAsync(PATH);
  if (info.exists) {
    cached = (await FileSystem.readAsStringAsync(PATH)).trim();
    if (/^[0-9a-f-]{36}$/.test(cached)) return cached;
  }
  cached = Crypto.randomUUID();
  await FileSystem.writeAsStringAsync(PATH, cached);
  return cached;
}
