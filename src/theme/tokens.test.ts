import { COLOR_ROLES, PALETTES, TOKENS_REF } from "./tokens";
import { SIZES } from "./theme";

test("the palettes come from a tokens tag and have every colour role in both themes", () => {
  expect(TOKENS_REF).toMatch(/^tokens-v\d+\.\d+\.\d+$/);
  expect(COLOR_ROLES).toHaveLength(23);
  for (const theme of ["light", "dark"] as const) {
    expect(Object.keys(PALETTES[theme]).sort()).toEqual([...COLOR_ROLES].sort());
    for (const role of COLOR_ROLES) expect([theme, role, /^#[0-9a-f]{3,8}$/.test(PALETTES[theme][role])]).toEqual([theme, role, true]);
  }
  expect(PALETTES.light.bg).not.toBe(PALETTES.dark.bg);
});

test("touch targets are at least 48 dp and the base text at least 18 sp", () => {
  expect(SIZES.touch).toBeGreaterThanOrEqual(48);
  expect(SIZES.text).toBeGreaterThanOrEqual(18);
});
