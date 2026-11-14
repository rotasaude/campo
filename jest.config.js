/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/android",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/android/", "/ios/"],
};
