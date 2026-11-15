import { Redirect } from "expo-router";

// Only the e2e build has this screen. The literal check lets the bundler drop the branch — and the two modules — from
// every other build, where the route only sends the person home.
export default function DiagnosticsRoute() {
  if (process.env.EXPO_PUBLIC_E2E === "1") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DiagnosticsScreen } = require("../../src/features/diagnostics/DiagnosticsScreen") as typeof import("../../src/features/diagnostics/DiagnosticsScreen");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { probeWithoutKey } = require("../../src/app/e2eDiagnostics") as typeof import("../../src/app/e2eDiagnostics");
    return <DiagnosticsScreen probe={probeWithoutKey} />;
  }
  return <Redirect href="/" />;
}
