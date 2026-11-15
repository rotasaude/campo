import { render, screen } from "@testing-library/react-native";
import { StyleSheet, Text } from "react-native";
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

  it("uses only its own padding when there is no inset to respect", async () => {
    await render(<Screen><Text>Sobre</Text></Screen>);
    expect(padding()).toMatchObject({
      paddingTop: SIZES.pad, paddingBottom: SIZES.pad, paddingLeft: SIZES.pad, paddingRight: SIZES.pad,
    });
  });
});
