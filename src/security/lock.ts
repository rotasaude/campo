// The PIN is asked when the app opens and after 5 minutes in the background.
export const LOCK_AFTER_MS = 5 * 60_000;

// `backgroundedAt`: when the app left the foreground; null on a cold start.
// A clock that went backwards (negative interval) locks too.
export function shouldLock(backgroundedAt: number | null, now: number): boolean {
  if (backgroundedAt === null) return true;
  const away = now - backgroundedAt;
  return away < 0 || away >= LOCK_AFTER_MS;
}

// Whether a sync may run now. The PIN is asked when the app comes back, but a tablet left in the background past the
// limit already owes it: from then on nothing is read from or sent to the server, even before anybody looks at it.
export function syncLocked(unlocked: boolean, backgroundedAt: number | null, now: number): boolean {
  return !unlocked || (backgroundedAt !== null && shouldLock(backgroundedAt, now));
}
