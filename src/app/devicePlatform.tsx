// The real platform: the only file of the app that imports the Expo modules.
// Everything here is thin on purpose — the logic lives behind the ports and is
// tested there; what this file does can only be proved on a device.
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as LegacyFs from "expo-file-system/legacy";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { forgetExpoDb, openExpoDb } from "../db/expoDb";
import { Body, Button, Muted } from "../ui/components";
import type { Platform } from "./platform";

type Extra = { allowedHostSuffixes?: string[]; devOrigin?: string };
const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

// The camera is asked for only here, to read the pairing QR, and only QR codes are read.
function QrCamera({ onScanned }: { onScanned(text: string): void }) {
  const [permission, request] = useCameraPermissions();
  if (!permission) return <Muted>Abrindo a câmera…</Muted>;
  if (!permission.granted) {
    return (
      <>
        <Body>O app usa a câmera só para ler o QR do dashboard.</Body>
        <Button label="Permitir câmera" onPress={() => { void request(); }} />
      </>
    );
  }
  return (
    <CameraView style={{ height: 360 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={({ data }) => onScanned(data)} />
  );
}

export const devicePlatform: Platform = {
  secure: {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) => SecureStore.setItemAsync(key, value),
    delete: (key) => SecureStore.deleteItemAsync(key),
  },
  crypto: {
    digestHex: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
    randomUUID: () => Crypto.randomUUID().toLowerCase(),
  },
  random: (n) => Crypto.getRandomBytes(n),
  now: () => Date.now(),
  fs: {
    documentDirectory: LegacyFs.documentDirectory ?? "",
    makeDirectoryAsync: (uri, options) => LegacyFs.makeDirectoryAsync(uri, options),
    deleteAsync: (uri, options) => LegacyFs.deleteAsync(uri, options),
    moveAsync: (move) => LegacyFs.moveAsync(move),
    getInfoAsync: async (uri) => {
      const info = await LegacyFs.getInfoAsync(uri);
      return info.exists ? { exists: true, size: info.size } : { exists: false };
    },
  },
  net: {
    // Connected is enough: "internet reachable" on Android is the system's own probe, which a city-hall
    // network or a captive portal may block while the secretariat's host answers. The request decides.
    isOnline: async () => (await Network.getNetworkStateAsync()).isConnected === true,
    isWifi: async () => (await Network.getNetworkStateAsync()).type === Network.NetworkStateType.WIFI,
  },
  openRaw: openExpoDb,
  forgetDb: forgetExpoDb,
  appState: { addEventListener: (event, listener) => AppState.addEventListener(event, listener) },
  downloader: {
    // The resumable download of the file system module. On Android the resume data is only the offset: the
    // request goes with "Range: bytes=<offset>-" (our headers are added after it) and the body is appended.
    async run({ url, fileUri, headers, resumeFrom }) {
      const task = LegacyFs.createDownloadResumable(url, fileUri, { headers }, undefined, resumeFrom === null ? undefined : String(resumeFrom));
      const result = resumeFrom === null ? await task.downloadAsync() : await task.resumeAsync();
      if (!result) throw new Error("download interrompido");
      return { status: result.status };
    },
  },
  // The whole file, hashed natively (12 ms for 15 MB in the technical proof; a JavaScript hash took seconds).
  sha256File: async (uri) => String(await new File(uri).digest("SHA-256")).toLowerCase(),
  Camera: QrCamera,
  build: {
    appVersion: Constants.expoConfig?.version ?? "0.0.0",
    allowedHostSuffixes: extra.allowedHostSuffixes ?? [],
    devOrigin: extra.devOrigin,
  },
};
