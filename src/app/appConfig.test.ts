import { buildConfig } from "../../app.config";

const RELEASE = { CAMPO_ALLOWED_HOST_SUFFIXES: ".rotasaude.example" };

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
