import { SYNC_INTERVAL_MS, startScheduler } from "./scheduler";

function setup(o: { online?: boolean; locked?: boolean } = {}) {
  const state = { online: o.online ?? true, locked: o.locked ?? false };
  let listener: ((status: string) => void) | null = null;
  const removed = jest.fn();
  const run = jest.fn(async () => undefined);
  const stop = startScheduler({
    run,
    appState: { addEventListener: (_event: "change", fn: (status: string) => void) => { listener = fn; return { remove: removed }; } },
    net: { isOnline: async () => state.online },
    isLocked: () => state.locked,
  });
  return { state, run, stop, removed, change: (status: string) => listener?.(status) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("scheduler: foreground and 15-min timer, never while locked", async () => {
  const t = setup();
  expect(SYNC_INTERVAL_MS).toBe(15 * 60_000);
  expect(t.run).not.toHaveBeenCalled(); // the round at open belongs to the app shell, after the PIN

  t.change("background");
  t.change("active");
  await jest.advanceTimersByTimeAsync(0);
  expect(t.run.mock.calls).toEqual([["foreground"]]);

  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1);
  expect(t.run).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(t.run.mock.calls).toEqual([["foreground"], ["timer"]]);

  t.state.locked = true;
  t.change("background");
  t.change("active");
  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
  expect(t.run).toHaveBeenCalledTimes(2);
});

test("the timer only fires with a network; coming to the foreground from inactive is not a return", async () => {
  const t = setup({ online: false });
  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 2);
  expect(t.run).not.toHaveBeenCalled();
  t.state.online = true;
  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
  expect(t.run.mock.calls).toEqual([["timer"]]);
  // active → active (or the first "active" with no background before) is not a return to the foreground.
  t.change("active");
  await jest.advanceTimersByTimeAsync(0);
  expect(t.run).toHaveBeenCalledTimes(1);
});

test("stopping removes the listener and the timer; a failing round never breaks the schedule", async () => {
  const t = setup();
  t.run.mockRejectedValueOnce(new Error("boom"));
  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
  expect(t.run).toHaveBeenCalledTimes(2);
  t.stop();
  expect(t.removed).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(SYNC_INTERVAL_MS * 3);
  expect(t.run).toHaveBeenCalledTimes(2);
});
