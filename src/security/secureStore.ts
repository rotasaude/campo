// The Android Keystore-backed store, as a port: the pure modules never import
// expo-secure-store. No key here requires authentication (the PIN is the
// app's own lock; the database key must be readable by the background sync).
export interface SecureStorePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const SECURE_KEYS = {
  dbKey: "campo.db_key",
  token: "campo.token",
  host: "campo.host",
  userId: "campo.user_id",
  pinHash: "campo.pin_hash",
  pinSalt: "campo.pin_salt",
  pinFailures: "campo.pin_failures",
  locked: "campo.locked",
} as const;
