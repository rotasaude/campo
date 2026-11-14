import type { ExpoConfig } from "expo/config";

import pkg from "./package.json";

/**
 * The only place that reads build flags.
 * - CAMPO_ALLOWED_HOST_SUFFIXES: comma-separated host suffixes the QR may point to (Q44).
 *   A release build without it does not compile.
 * - EXPO_PUBLIC_E2E=1: e2e build (diagnostics screen, dev origin allowed).
 * - APP_VARIANT=development: development build (dev origin allowed).
 * - EXPO_PUBLIC_DEV_ORIGIN: origin used only by development and e2e builds.
 * - CAMPO_E2E_SCREEN_CAPTURE=1: e2e build without FLAG_SECURE, only to record evidence.
 */
export type BuildEnv = Record<string, string | undefined>;

/** A suffix is ".label(.label)*": the leading dot keeps "evil-rotasaude.example" from matching. */
const HOST_SUFFIX = /^(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Suffixes that only a development or e2e build may carry. */
const TEST_SUFFIX = /\.(localhost|test)$/;

function hostSuffixes(raw: string | undefined, production: boolean): string[] {
  const suffixes = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const suffix of suffixes) {
    if (!HOST_SUFFIX.test(suffix)) {
      throw new Error(`CAMPO_ALLOWED_HOST_SUFFIXES: sufixo de host inválido: "${suffix}" (use a forma ".dominio.example")`);
    }
    if (production && (TEST_SUFFIX.test(suffix) || suffix.lastIndexOf(".") === 0)) {
      throw new Error(`CAMPO_ALLOWED_HOST_SUFFIXES: "${suffix}" não vale no build de produção`);
    }
  }
  if (production && suffixes.length === 0) {
    throw new Error("CAMPO_ALLOWED_HOST_SUFFIXES ausente: o build de release exige a lista de hosts do QR");
  }
  return suffixes;
}

/** 0.1.0 → 100; each part of the version stays below 100. */
function versionCode(version: string): number {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 99)) {
    throw new Error(`versão do package.json fora da forma x.y.z (0 a 99): ${version}`);
  }
  const [major, minor, patch] = parts as [number, number, number];
  return major * 10000 + minor * 100 + patch;
}

export function buildConfig(env: BuildEnv): ExpoConfig {
  const e2e = env.EXPO_PUBLIC_E2E === "1";
  const development = env.APP_VARIANT === "development";
  const allowedHostSuffixes = hostSuffixes(env.CAMPO_ALLOWED_HOST_SUFFIXES, !e2e && !development);
  const devOrigin = e2e || development ? env.EXPO_PUBLIC_DEV_ORIGIN : undefined;
  // Cleartext only to the emulator's host (fake server, dev api) and, in development, to Metro.
  const devCleartextHosts = development ? ["10.0.2.2", "localhost"] : e2e ? ["10.0.2.2"] : [];

  return {
    name: "Rota Saúde Campo",
    slug: "campo",
    version: pkg.version,
    orientation: "default",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    android: {
      package: "br.rotasaude.campo",
      versionCode: versionCode(pkg.version),
      allowBackup: false,
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      permissions: ["CAMERA", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "INTERNET", "ACCESS_NETWORK_STATE"],
      blockedPermissions: [
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.VIBRATE",
        "android.permission.WAKE_LOCK",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.ACCESS_WIFI_STATE",
      ],
    },
    plugins: [
      "expo-router",
      ["expo-sqlite", { useSQLCipher: true }],
      ["expo-secure-store", { configureAndroidBackup: false }],
      "expo-asset",
      "@maplibre/maplibre-react-native",
      ["expo-camera", { recordAudioAndroid: false }],
      ["expo-location", { isAndroidBackgroundLocationEnabled: false, isAndroidForegroundServiceEnabled: false }],
      [
        "./plugins/withFieldHardening",
        { e2e, devCleartextHosts, allowScreenCapture: e2e && env.CAMPO_E2E_SCREEN_CAPTURE === "1" },
      ],
      "./plugins/withMapAssets",
      ["./plugins/withReleaseSigning", { e2e }],
    ],
    extra: { allowedHostSuffixes, e2e, ...(devOrigin ? { devOrigin } : {}) },
  };
}

export default (): ExpoConfig => buildConfig(process.env);
