import { MissingChoiceError, applyChoices, canonical, merge } from "./merge";

const base = {
  property_type: "1", contact_phone: "4100", address: { street: "A", number: "1" },
  living_conditions: { abastecimento_de_agua: 117, destino_do_lixo: 1 },
};

test("only tablet changed → tablet wins", () =>
  expect(merge(base, { ...base, contact_phone: "4199" }, base)).toEqual({ body: { ...base, contact_phone: "4199" }, conflicts: [] }));

test("only station changed → station wins", () =>
  expect(merge(base, base, { ...base, contact_phone: "4188" })).toEqual({ body: { ...base, contact_phone: "4188" }, conflicts: [] }));

test("both changed to the same value → no conflict", () =>
  expect(merge(base, { ...base, contact_phone: "4177" }, { ...base, contact_phone: "4177" }))
    .toEqual({ body: { ...base, contact_phone: "4177" }, conflicts: [] }));

test("both changed differently → conflict with station and tablet values", () => {
  const r = merge(base, { ...base, contact_phone: "1" }, { ...base, contact_phone: "2" });
  expect(r.conflicts).toEqual([{ path: "contact_phone", station: "2", tablet: "1" }]);
  expect(r.body.contact_phone).toBe("2"); // the body carries the station's until the choice
});

test("each side changed a different field → both changes kept, no conflict", () => {
  const r = merge(base, { ...base, contact_phone: "1" }, { ...base, property_type: "2" });
  expect(r).toEqual({ body: { ...base, contact_phone: "1", property_type: "2" }, conflicts: [] });
});

test("dictionary section merges key by key", () => {
  const local = { ...base, living_conditions: { ...base.living_conditions, abastecimento_de_agua: 118 } };
  const current = { ...base, living_conditions: { ...base.living_conditions, destino_do_lixo: 2 } };
  const r = merge(base, local, current);
  expect(r.body.living_conditions).toEqual({ abastecimento_de_agua: 118, destino_do_lixo: 2 });
  expect(r.conflicts).toEqual([]);
});

test("the same key of a section changed on both sides → conflict named section.key", () => {
  const local = { ...base, living_conditions: { ...base.living_conditions, destino_do_lixo: 3 } };
  const current = { ...base, living_conditions: { ...base.living_conditions, destino_do_lixo: 2 } };
  expect(merge(base, local, current).conflicts).toEqual([{ path: "living_conditions.destino_do_lixo", station: 2, tablet: 3 }]);
});

test("lists are one field (deficiencias_cidadao changed on both → one conflict)", () => {
  const b = { health_conditions: { deficiencias_cidadao: [12], fumante: false } };
  const local = { health_conditions: { deficiencias_cidadao: [12, 13], fumante: false } };
  const current = { health_conditions: { deficiencias_cidadao: [14], fumante: true } };
  const r = merge(b, local, current);
  expect(r.conflicts).toEqual([{ path: "health_conditions.deficiencias_cidadao", station: [14], tablet: [12, 13] }]);
  expect(r.body.health_conditions).toEqual({ deficiencias_cidadao: [14], fumante: true });
});

test("address is one field: street on tablet, number on station → conflict on address", () => {
  const local = { ...base, address: { street: "B", number: "1" } };
  const current = { ...base, address: { street: "A", number: "2" } };
  expect(merge(base, local, current).conflicts).toEqual([{ path: "address", station: current.address, tablet: local.address }]);
});

test("location is one field", () => {
  const b = { location: { latitude: -25.4, longitude: -49.2, source: "map" } };
  const local = { location: { latitude: -25.41, longitude: -49.2, accuracy_m: 8.5, source: "gps" } };
  const current = { location: { latitude: -25.4, longitude: -49.21, source: "map" } };
  expect(merge(b, local, current).conflicts).toEqual([{ path: "location", station: current.location, tablet: local.location }]);
  expect(merge(b, local, b)).toEqual({ body: { location: local.location }, conflicts: [] });
  expect(merge(b, { location: null }, b)).toEqual({ body: { location: null }, conflicts: [] });
});

test("key added inside a section by station only is kept", () => {
  const current = { ...base, living_conditions: { ...base.living_conditions, nu_comodos: 4 } };
  expect(merge(base, base, current).body.living_conditions).toEqual({ abastecimento_de_agua: 117, destino_do_lixo: 1, nu_comodos: 4 });
});

test("key removed inside a section by the tablet only is left out", () => {
  const local = { ...base, living_conditions: { abastecimento_de_agua: 117 } };
  expect(merge(base, local, base).body.living_conditions).toEqual({ abastecimento_de_agua: 117 });
});

test("section null on one side counts as a single field", () => {
  const local = { ...base, living_conditions: null };
  const current = { ...base, living_conditions: { ...base.living_conditions, destino_do_lixo: 2 } };
  expect(merge(base, local, current).conflicts).toEqual([{ path: "living_conditions", station: current.living_conditions, tablet: null }]);
  expect(merge(base, local, base).body.living_conditions).toBeNull();
  expect(merge({ ...base, living_conditions: null }, { ...base, living_conditions: null }, current).body.living_conditions).toEqual(current.living_conditions);
});

test("key order does not create a false conflict", () => {
  const local = { ...base, address: { number: "1", street: "A" }, contact_phone: "9" };
  const current = { living_conditions: { destino_do_lixo: 1, abastecimento_de_agua: 117 }, address: { street: "A", number: "1" }, contact_phone: "4100", property_type: "1" };
  expect(merge(base, local, current).conflicts).toEqual([]);
  expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonical({ a: [{ c: 2, d: 1 }], b: 1 }));
});

test("absent vs null are different values", () => {
  expect(canonical(undefined)).toBe("∅");
  expect(canonical(null)).toBe("null");
  const { contact_phone: _gone, ...withoutPhone } = base;
  // The tablet cleared the phone (null); the station never touched it: the tablet's null wins.
  expect(merge(base, { ...base, contact_phone: null }, base).body.contact_phone).toBeNull();
  // The station's body has no key at all, the tablet set null: both changed, differently.
  expect(merge(base, { ...base, contact_phone: null }, withoutPhone).conflicts).toEqual([{ path: "contact_phone", station: undefined, tablet: null }]);
  // Absent on the result is left out, not written as undefined.
  expect(Object.keys(merge(base, base, withoutPhone).body)).not.toContain("contact_phone");
});

test("applyChoices requires every path", () => {
  const local = { ...base, contact_phone: "1", living_conditions: { ...base.living_conditions, destino_do_lixo: 3 } };
  const current = { ...base, contact_phone: "2", living_conditions: { ...base.living_conditions, destino_do_lixo: 2 } };
  const r = merge(base, local, current);
  expect(r.conflicts.map((c) => c.path)).toEqual(["contact_phone", "living_conditions.destino_do_lixo"]);
  expect(() => applyChoices(r.body, r.conflicts, { contact_phone: "tablet" })).toThrow(MissingChoiceError);
  try { applyChoices(r.body, r.conflicts, {}); } catch (err) { expect((err as MissingChoiceError).paths).toEqual(["contact_phone", "living_conditions.destino_do_lixo"]); }

  const chosen = applyChoices(r.body, r.conflicts, { contact_phone: "tablet", "living_conditions.destino_do_lixo": "station" });
  expect(chosen.contact_phone).toBe("1");
  expect(chosen.living_conditions).toEqual({ abastecimento_de_agua: 117, destino_do_lixo: 2 });
  expect(r.body.contact_phone).toBe("2"); // the merged body is not changed in place
});

test("applyChoices: choosing the side where the key is absent removes it", () => {
  const { contact_phone: _gone, ...withoutPhone } = base;
  const r = merge(base, { ...base, contact_phone: null }, withoutPhone);
  expect(Object.keys(applyChoices(r.body, r.conflicts, { contact_phone: "station" }))).not.toContain("contact_phone");
  expect(applyChoices(r.body, r.conflicts, { contact_phone: "tablet" }).contact_phone).toBeNull();
});
