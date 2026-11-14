// The app's own lock: a 6-digit PIN. Only a salt and SHA-256(salt + PIN) are
// stored (Android Keystore). Five wrong in a row lock the app for good — the
// way out is to register the device again, which wipes it.
import type { CryptoPort } from "../app/services";
import { SECURE_KEYS, type SecureStorePort } from "./secureStore";

export const PIN_LENGTH = 6;
export const MAX_PIN_FAILURES = 5;

export class InvalidPinError extends Error {
  constructor() { super(`o PIN tem ${PIN_LENGTH} dígitos`); }
}

const PIN = new RegExp(`^\\d{${PIN_LENGTH}}$`);
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
type Hash = Pick<CryptoPort, "digestHex">;

export async function setPin(secure: SecureStorePort, pin: string, random: (n: number) => Uint8Array, crypto: Hash): Promise<void> {
  if (!PIN.test(pin)) throw new InvalidPinError();
  const salt = hex(random(16));
  await secure.set(SECURE_KEYS.pinSalt, salt);
  await secure.set(SECURE_KEYS.pinHash, await crypto.digestHex(salt + pin));
  await secure.delete(SECURE_KEYS.pinFailures);
  await secure.delete(SECURE_KEYS.locked);
}

export async function isLocked(secure: SecureStorePort): Promise<boolean> {
  return (await secure.get(SECURE_KEYS.locked)) === "1";
}

export async function hasPin(secure: SecureStorePort): Promise<boolean> {
  return (await secure.get(SECURE_KEYS.pinHash)) !== null;
}

// "locked" also when no PIN was ever set: nothing to compare with is not a way in.
export async function checkPin(secure: SecureStorePort, pin: string, crypto: Hash): Promise<"ok" | "wrong" | "locked"> {
  if (await isLocked(secure)) return "locked";
  const salt = await secure.get(SECURE_KEYS.pinSalt);
  const stored = await secure.get(SECURE_KEYS.pinHash);
  if (salt === null || stored === null) return "locked";

  if (PIN.test(pin) && (await crypto.digestHex(salt + pin)) === stored) {
    await secure.delete(SECURE_KEYS.pinFailures);
    return "ok";
  }
  const failures = (Number(await secure.get(SECURE_KEYS.pinFailures)) || 0) + 1;
  await secure.set(SECURE_KEYS.pinFailures, String(failures));
  if (failures < MAX_PIN_FAILURES) return "wrong";
  await secure.set(SECURE_KEYS.locked, "1");
  return "locked";
}
