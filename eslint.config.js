const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { ignores: ["android/*", "ios/*", "dist/*", ".expo/*", "src/contract/generated/*"] },
  {
    rules: {
      "no-console": "error",
      // The network is reached in two places only: the field API client and the map download.
      "no-restricted-globals": ["error",
        { name: "fetch", message: "A rede só é usada em src/sync/http.ts e src/map/download.ts." },
        { name: "XMLHttpRequest", message: "A rede só é usada em src/sync/http.ts e src/map/download.ts." },
        { name: "WebSocket", message: "O app não abre conexões além do cliente do field sync." },
      ],
      "no-restricted-properties": ["error",
        { object: "globalThis", property: "fetch", message: "A rede só é usada em src/sync/http.ts e src/map/download.ts." },
        { object: "global", property: "fetch", message: "A rede só é usada em src/sync/http.ts e src/map/download.ts." },
      ],
    },
  },
  { files: ["src/log.ts"], rules: { "no-console": "off" } },
  { files: ["src/sync/http.ts", "src/map/download.ts"], rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" } },
  // Tests spy on the platform's fetch and on console to prove nothing leaks.
  { files: ["**/*.test.ts", "**/*.test.tsx", "src/**/testing.ts", "jest.setup.ts"], rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" } },
]);
