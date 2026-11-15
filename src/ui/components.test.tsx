import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { DeviceEventEmitter, StyleSheet, Text } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { SIZES } from "../theme/theme";
import { Screen } from "./components";

// The app draws edge to edge: without the insets the title sits under the status bar and the last button
// under the navigation bar (on a tablet, the taskbar), where the touch lands on the system instead of the app.
describe("Screen", () => {
  // The scroll container is the nearest ancestor of the content that carries a contentContainerStyle.
  const padding = () => {
    let node = screen.getByText("Sobre").parent;
    while (node && node.props.contentContainerStyle === undefined) node = node.parent;
    return StyleSheet.flatten(node?.props.contentContainerStyle);
  };

  it("keeps the content clear of the system bars on the four sides", async () => {
    await render(
      <SafeAreaInsetsContext.Provider value={{ top: 40, bottom: 120, left: 8, right: 24 }}>
        <Screen title="Início"><Text>Sobre</Text></Screen>
      </SafeAreaInsetsContext.Provider>,
    );
    expect(padding()).toMatchObject({
      paddingTop: SIZES.pad + 40, paddingBottom: SIZES.pad + 120, paddingLeft: SIZES.pad + 8, paddingRight: SIZES.pad + 24,
    });
  });

  // Edge to edge, Android does not resize the window for the keyboard: on a tablet it takes half the screen,
  // and a field in focus below its top is typed blind. The scroll area must end where the keyboard begins
  // (the native scroll then brings the field in focus into what is left).
  it("ends the scroll area at the keyboard's top while the keyboard is open", async () => {
    await render(<Screen title="Novo domicílio"><Text>Sobre</Text></Screen>);
    // What holds the scroll: the nearest ancestor of it that listens to its own layout.
    let holder = screen.getByText("Sobre").parent;
    while (holder && holder.props.contentContainerStyle === undefined) holder = holder.parent;
    holder = holder?.parent ?? null;
    while (holder && typeof holder.props.onLayout !== "function") holder = holder.parent;
    expect(holder).not.toBeNull();
    const bottom = () => StyleSheet.flatten(holder?.props.style).paddingBottom;

    // A tablet in landscape, 1280 x 800 dp, with a keyboard of 426 dp.
    await fireEvent(holder!, "layout", { nativeEvent: { layout: { x: 0, y: 0, width: 1280, height: 800 } }, persist: () => undefined });
    await act(async () => {
      DeviceEventEmitter.emit("keyboardDidShow", { endCoordinates: { screenX: 0, screenY: 374, width: 1280, height: 426 }, duration: 0, easing: "keyboard" });
    });
    await waitFor(() => expect(bottom()).toBe(426));

    await act(async () => {
      DeviceEventEmitter.emit("keyboardDidHide", { endCoordinates: { screenX: 0, screenY: 800, width: 1280, height: 0 }, duration: 0, easing: "keyboard" });
    });
    await waitFor(() => expect(bottom()).toBe(0));
  });

  it("uses only its own padding when there is no inset to respect", async () => {
    await render(<Screen><Text>Sobre</Text></Screen>);
    expect(padding()).toMatchObject({
      paddingTop: SIZES.pad, paddingBottom: SIZES.pad, paddingLeft: SIZES.pad, paddingRight: SIZES.pad,
    });
  });
});
