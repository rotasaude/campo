const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  { ignores: ["android/*", "ios/*", "dist/*", ".expo/*", "src/contract/generated/*"] },
  { rules: { "no-console": "error" } },
  { files: ["src/log.ts"], rules: { "no-console": "off" } },
]);
