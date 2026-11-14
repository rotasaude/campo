import { householdFeatures, type HouseholdPoint } from "./householdLayer";

const point = (o: Partial<HouseholdPoint> & Pick<HouseholdPoint, "key">): HouseholdPoint =>
  ({ id: o.key, location: { latitude: -25.42847123, longitude: -49.27325411 }, ...o });

const rows: HouseholdPoint[] = [
  point({ key: "hh1" }),
  point({ key: "hh2", location: { latitude: -25.5, longitude: -49.3 } }),
  point({ key: "hh3" }),
  point({ key: "born-on-tablet", id: null }),
  point({ key: "no-point", location: null }),
];
const who = new Set(["hh2", "hh3"]);
const today = new Set(["hh3", "born-on-tablet"]);

test("one point per household that has a location, as [longitude, latitude]", () => {
  const f = householdFeatures(rows, who, today);
  expect(f.type).toBe("FeatureCollection");
  expect(f.features.map((x) => x.properties.key)).toEqual(["hh1", "hh2", "hh3", "born-on-tablet"]);
  expect(f.features[1].geometry).toEqual({ type: "Point", coordinates: [-49.3, -25.5] });
});

test("features carry no personal data", () => {
  const f = householdFeatures(rows, who, today);
  expect(Object.keys(f.features[0].properties).sort()).toEqual(["key", "status"]);
  for (const feature of f.features) expect(Object.keys(feature.properties).sort()).toEqual(["key", "status"]);
});

test("visited today wins over to-visit", () => {
  const status = Object.fromEntries(householdFeatures(rows, who, today).features.map((x) => [x.properties.key, x.properties.status]));
  expect(status).toEqual({ hh1: "registered", hh2: "to_visit", hh3: "visited_today", "born-on-tablet": "visited_today" });
});

test("the lists may name a household by its server id or by its local key", () => {
  const born: HouseholdPoint[] = [point({ key: "c0ffee30", id: "8c9d0e1f" })];
  expect(householdFeatures(born, new Set(["8c9d0e1f"]), new Set()).features[0].properties.status).toBe("to_visit");
  expect(householdFeatures(born, new Set(), new Set(["c0ffee30"])).features[0].properties.status).toBe("visited_today");
  expect(householdFeatures([], who, today).features).toEqual([]);
});
