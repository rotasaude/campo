import { useApp } from "../../src/app/AppRoot";
import { AboutScreen } from "../../src/features/about/AboutScreen";

export default function AboutRoute() {
  const app = useApp();
  return <AboutScreen appVersion={app.appVersion} onSignOut={app.signOut} />;
}
