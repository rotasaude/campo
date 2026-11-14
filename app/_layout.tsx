import { Stack } from "expo-router";
import { AppRoot } from "../src/app/AppRoot";
import { devicePlatform } from "../src/app/devicePlatform";

// The shell decides what comes before the routes (fatal, pairing, PIN, suspended, first load);
// the routes below only exist for an unlocked, loaded app.
export default function RootLayout() {
  return (
    <AppRoot platform={devicePlatform}>
      <Stack screenOptions={{ headerShown: false }} />
    </AppRoot>
  );
}
