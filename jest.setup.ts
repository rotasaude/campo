// Mocks of the native modules; the pure modules receive ports through AppServices.
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});
jest.mock("@maplibre/maplibre-react-native", () => ({}));
jest.mock("expo-location", () => ({}));
jest.mock("expo-camera", () => ({}));
jest.mock("expo-network", () => ({}));

// The app's only log point (src/log.ts) writes JSON lines to console.log. The suites stay quiet;
// a test that wants to read the lines spies on console itself.
beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});
