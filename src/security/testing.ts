// Test support: an in-memory secure store and a real SHA-256 for the crypto port.
import { createHash } from "node:crypto";
import type { SecureStorePort } from "./secureStore";

export function memorySecure(initial: Record<string, string> = {}): SecureStorePort & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  };
}

export const sha256 = { digestHex: async (text: string) => createHash("sha256").update(text).digest("hex") };
export const fixedRandom = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 11 + 5) % 256);
