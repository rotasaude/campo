import type { ExpoConfig } from "expo/config";

/**
 * The only place that reads build flags.
 * - CAMPO_ALLOWED_HOST_SUFFIXES: comma-separated host suffixes the QR may point to (Q44).
 *   A release build without it does not compile.
 * - EXPO_PUBLIC_E2E=1: e2e build (diagnostics screen, dev origin allowed).
 * - APP_VARIANT=development: development build (dev origin allowed).
 * - EXPO_PUBLIC_DEV_ORIGIN: origin used only by development and e2e builds.
 */
export type BuildEnv = Record<string, string | undefined>;

export function buildConfig(env: BuildEnv): ExpoConfig {
  const e2e = env.EXPO_PUBLIC_E2E === "1";
  const development = env.APP_VARIANT === "development";
  const allowedHostSuffixes = (env.CAMPO_ALLOWED_HOST_SUFFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!e2e && !development && allowedHostSuffixes.length === 0) {
    throw new Error("CAMPO_ALLOWED_HOST_SUFFIXES ausente: o build de release exige a lista de hosts do QR");
  }
  const devOrigin = e2e || development ? env.EXPO_PUBLIC_DEV_ORIGIN : undefined;

  return {
    name: "Rota Saúde Campo",
    slug: "campo",
    version: "0.1.0",
    orientation: "default",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    android: {
      package: "br.rotasaude.campo",
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
      ],
    },
    plugins: [
      "expo-router",
      ["expo-sqlite", { useSQLCipher: true }],
      "expo-secure-store",
      "expo-asset",
      "@maplibre/maplibre-react-native",
      ["expo-camera", { recordAudioAndroid: false }],
      ["expo-location", { isAndroidBackgroundLocationEnabled: false, isAndroidForegroundServiceEnabled: false }],
    ],
    extra: { allowedHostSuffixes, e2e, ...(devOrigin ? { devOrigin } : {}) },
  };
}

export default (): ExpoConfig => buildConfig(process.env);
