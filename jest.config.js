/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/android",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/android/", "/ios/"],
  // The first render of a screen in each worker loads React Native: with the suites in parallel in the test container
  // it can take longer than Jest's 5 s default.
  testTimeout: 20000,
};
