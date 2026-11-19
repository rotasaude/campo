import { fireEvent, render, screen } from "@testing-library/react-native";
import { useState } from "react";
import { Counter } from "./counter";

function Harness({ initial, max }: { initial: string; max: number }) {
  const [value, setValue] = useState(initial);
  return <Counter label="Com água" value={value} max={max} onChange={setValue} testID="counter" />;
}

test("− and + step by one, never below 0 nor above max; the number can be typed", async () => {
  await render(<Harness initial="0" max={2} />);
  const input = () => screen.getByLabelText("Com água");
  await fireEvent.press(screen.getByRole("button", { name: "Diminuir Com água" }));
  expect(input().props.value).toBe("0");
  for (let i = 0; i < 3; i += 1) await fireEvent.press(screen.getByRole("button", { name: "Aumentar Com água" }));
  expect(input().props.value).toBe("2");
  await fireEvent.changeText(input(), "");
  expect(input().props.value).toBe("");
  await fireEvent.press(screen.getByRole("button", { name: "Aumentar Com água" }));
  expect(input().props.value).toBe("1");
  await fireEvent.changeText(input(), "15");
  expect(input().props.value).toBe("2");
  await fireEvent.changeText(input(), "-1");
  expect(input().props.value).toBe("1");
});
