import { createContext, useContext } from "react";
import type { Db } from "../db/types";
import type { SecureStorePort } from "../security/secureStore";
import type { FsPort as WipeFsPort } from "../security/wipe";

/**
 * Ports injected into the pure modules (src/sync, src/rules, src/security, src/map).
 * Nothing in those modules imports a native module directly. The following tasks
 * replace each `unknown` with the port's interface.
 */
export type DbPort = Db;
export type SecurePort = SecureStorePort;
// Undefined: the field API client uses the platform's own fetch.
export type HttpPort = typeof fetch | undefined;
export type FsPort = WipeFsPort;
export type NetPort = unknown;
export type LocationPort = unknown;
export type CameraPort = unknown;

export interface CryptoPort {
  digestHex(text: string): Promise<string>;
  randomUUID(): string;
}

export interface AppServices {
  db: DbPort;
  secure: SecurePort;
  http: HttpPort;
  fs: FsPort;
  net: NetPort;
  location: LocationPort;
  camera: CameraPort;
  crypto: CryptoPort;
  now: () => number;
  random: (n: number) => Uint8Array;
}

const ServicesContext = createContext<AppServices | null>(null);

export const ServicesProvider = ServicesContext.Provider;

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("AppServices ausente: monte o ServicesProvider na raiz");
  return services;
}
