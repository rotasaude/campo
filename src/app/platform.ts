// Everything the app needs from the device, in one object. The real one
// (devicePlatform.ts) is built from the Expo modules and is the only file that
// imports them; the tests build a fake one. Nothing below this line of the
// app knows which it got.
import type { ComponentType } from "react";
import type { Db } from "../db/types";
import type { LocationPort } from "../location/capture";
import type { MapCanvasProps } from "../map/canvas";
import type { MapDownloader, MapFsPort } from "../map/download";
import type { SecureStorePort } from "../security/secureStore";
import type { CryptoPort } from "./services";

export interface Platform {
  secure: SecureStorePort;
  crypto: CryptoPort;
  random(n: number): Uint8Array;
  now(): number;
  fs: MapFsPort;
  net: { isOnline(): Promise<boolean>; isWifi(): Promise<boolean> };
  // The SQLCipher connection (one per process) and how to forget it after the file is erased.
  openRaw(name: string): Promise<Db>;
  forgetDb(): void;
  // React Native's AppState: "active" | "background" | "inactive".
  appState: { addEventListener(event: "change", listener: (status: string) => void): { remove(): void } };
  downloader: MapDownloader;
  sha256File(uri: string): Promise<string>;
  // Undefined: the platform's own fetch.
  http?: typeof fetch;
  // The first bytes of a file (the map's header).
  readFileHead(uri: string, bytes: number): Promise<Uint8Array>;
  // The GPS: asked only when the person asks for their position or saves a visit.
  location: LocationPort;
  // What draws the map (MapLibre).
  MapCanvas: ComponentType<MapCanvasProps>;
  // The camera that reads the pairing QR.
  Camera: ComponentType<{ onScanned(text: string): void }>;
  build: { appVersion: string; allowedHostSuffixes: string[]; devOrigin?: string };
}
