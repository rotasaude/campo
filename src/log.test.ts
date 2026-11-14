import { log } from "./log";

const CLIENT_UUID = "0b9f6c1e-5d1a-4c1e-9a54-3f3f8f0f6a11";

afterEach(() => jest.restoreAllMocks());

test("writes one line with exactly the event and the given fields", () => {
  const spy = jest.spyOn(console, "log").mockImplementation(() => {});
  log("sync.item.result", { client_uuid: CLIENT_UUID, type: "household", code: "stale_version" });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]).toHaveLength(1);
  expect(JSON.parse(spy.mock.calls[0][0])).toEqual({
    event: "sync.item.result",
    client_uuid: CLIENT_UUID,
    type: "household",
    code: "stale_version",
  });
});

test("drops any field outside the allowed list, even when the type check is bypassed", () => {
  const spy = jest.spyOn(console, "log").mockImplementation(() => {});
  log("sync.item.result", { seq: 7, full_name: "Maria da Silva" } as never);
  expect(JSON.parse(spy.mock.calls[0][0])).toEqual({ event: "sync.item.result", seq: 7 });
});

test("a field with personal data does not compile", () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  // @ts-expect-error full_name is not a log field
  log("sync.item.result", { full_name: "Maria da Silva" });
});
