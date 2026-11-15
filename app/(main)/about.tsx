import { useRouter } from "expo-router";
import { useApp } from "../../src/app/AppRoot";
import { AboutScreen } from "../../src/features/about/AboutScreen";

export default function AboutRoute() {
  const app = useApp();
  const router = useRouter();
  // The way into the diagnostics exists only in the e2e build.
  const diagnostics = process.env.EXPO_PUBLIC_E2E === "1" ? () => router.push("/diagnostics") : undefined;
  return <AboutScreen appVersion={app.appVersion} onSignOut={app.signOut} onOpenDiagnostics={diagnostics} />;
}
