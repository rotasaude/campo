import { buildConfig } from "../../app.config";
import pkg from "../../package.json";

const RELEASE = { CAMPO_ALLOWED_HOST_SUFFIXES: ".rotasaude.example" };
const E2E = { EXPO_PUBLIC_E2E: "1", EXPO_PUBLIC_DEV_ORIGIN: "http://10.0.2.2:8787", CAMPO_ALLOWED_HOST_SUFFIXES: ".localhost,.test" };

type Plugin = string | [string, unknown?];

function pluginOptions(env: Record<string, string | undefined>, name: string): unknown {
  const entry = (buildConfig(env).plugins as Plugin[]).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  if (entry === undefined) throw new Error(`plugin ausente: ${name}`);
  return Array.isArray(entry) ? entry[1] : undefined;
}

test("android hardening and identity", () => {
  const c = buildConfig(RELEASE);
  expect(c.android?.package).toBe("br.rotasaude.campo");
  expect(c.android?.allowBackup).toBe(false);
  expect([...(c.android?.permissions ?? [])].sort()).toEqual([
    "ACCESS_COARSE_LOCATION",
    "ACCESS_FINE_LOCATION",
    "ACCESS_NETWORK_STATE",
    "CAMERA",
    "INTERNET",
  ]);
  expect(c.plugins).toContainEqual(["expo-sqlite", { useSQLCipher: true }]);
  expect(JSON.stringify(c)).not.toMatch(/sentry|crashlytics|firebase|bugsnag|mapbox\.com|googleapis/i);
});

test("production build has no dev origin nor e2e entry", () => {
  const c = buildConfig({ ...RELEASE, EXPO_PUBLIC_DEV_ORIGIN: "http://10.0.2.2:3030" });
  expect(c.extra?.devOrigin).toBeUndefined();
  expect(c.extra?.e2e).toBe(false);
  expect(c.extra?.allowedHostSuffixes).toEqual([".rotasaude.example"]);
});

test("release build without the host suffix list fails (Q44 gate)", () => {
  expect(() => buildConfig({})).toThrow(/CAMPO_ALLOWED_HOST_SUFFIXES ausente/);
});

test("a host suffix must start with a dot, so a look-alike host cannot match it (Q44)", () => {
  expect(() => buildConfig({ CAMPO_ALLOWED_HOST_SUFFIXES: "rotasaude.example" })).toThrow(/sufixo de host inválido/);
  expect(() => buildConfig({ CAMPO_ALLOWED_HOST_SUFFIXES: ".rotasaude.example,https://x.example" })).toThrow(
    /sufixo de host inválido/,
  );
  expect(() => buildConfig({ CAMPO_ALLOWED_HOST_SUFFIXES: "." })).toThrow(/sufixo de host inválido/);
});

test("production build refuses the test suffixes and a bare top-level domain (Q44)", () => {
  for (const suffix of [".localhost", ".test", ".br", ".curitiba.localhost"]) {
    expect(() => buildConfig({ CAMPO_ALLOWED_HOST_SUFFIXES: `.rotasaude.example,${suffix}` })).toThrow(
      /não vale no build de produção/,
    );
  }
  expect(buildConfig(E2E).extra?.allowedHostSuffixes).toEqual([".localhost", ".test"]);
});

test("the unlisted permissions the libraries bring are removed from the manifest", () => {
  const blocked = buildConfig(RELEASE).android?.blockedPermissions ?? [];
  // expo-network asks for the Wi-Fi state and expo-file-system for the shared storage.
  for (const name of ["ACCESS_WIFI_STATE", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "RECORD_AUDIO"]) {
    expect(blocked).toContain(`android.permission.${name}`);
  }
});

test("version and version code come from package.json", () => {
  const c = buildConfig(RELEASE);
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  expect(c.version).toBe(pkg.version);
  expect(c.android?.versionCode).toBe(major * 10000 + minor * 100 + patch);
  expect(c.android?.versionCode).toBeGreaterThan(0);
});

test("production hardening: screen protected, no cleartext host, upload key", () => {
  expect(pluginOptions(RELEASE, "./plugins/withFieldHardening")).toEqual({
    e2e: false,
    devCleartextHosts: [],
    allowScreenCapture: false,
  });
  expect(pluginOptions(RELEASE, "./plugins/withReleaseSigning")).toEqual({ e2e: false });
  // The app writes its own backup rules; SecureStore must not put its own back.
  expect(pluginOptions(RELEASE, "expo-secure-store")).toEqual({ configureAndroidBackup: false });
  expect(pluginOptions(RELEASE, "./plugins/withMapAssets")).toBeUndefined();
});

test("production ignores the screen capture switch", () => {
  expect(pluginOptions({ ...RELEASE, CAMPO_E2E_SCREEN_CAPTURE: "1" }, "./plugins/withFieldHardening")).toMatchObject({
    allowScreenCapture: false,
  });
});

test("e2e build allows cleartext only to the emulator host and signs with a throwaway key (Q48)", () => {
  expect(pluginOptions(E2E, "./plugins/withFieldHardening")).toEqual({
    e2e: true,
    devCleartextHosts: ["10.0.2.2"],
    allowScreenCapture: false,
  });
  expect(pluginOptions(E2E, "./plugins/withReleaseSigning")).toEqual({ e2e: true });
  expect(pluginOptions({ ...E2E, CAMPO_E2E_SCREEN_CAPTURE: "1" }, "./plugins/withFieldHardening")).toMatchObject({
    allowScreenCapture: true,
  });
});

test("development build reaches Metro in cleartext and nothing else", () => {
  expect(pluginOptions({ APP_VARIANT: "development" }, "./plugins/withFieldHardening")).toEqual({
    e2e: false,
    devCleartextHosts: ["10.0.2.2", "localhost"],
    allowScreenCapture: false,
  });
});

// Expo prefers src/app when it exists, and src/app is the app's shell (with its tests), not the routes.
test("the routes come from app/, never from src/app", () => {
  for (const env of [RELEASE, E2E, { APP_VARIANT: "development" }]) expect(pluginOptions(env, "expo-router")).toEqual({ root: "app" });
});
