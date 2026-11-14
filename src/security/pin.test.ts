import { InvalidPinError, MAX_PIN_FAILURES, PIN_LENGTH, checkPin, hasPin, isLocked, setPin } from "./pin";
import { SECURE_KEYS } from "./secureStore";
import { fixedRandom as rnd, memorySecure, sha256 } from "./testing";

test("stores only salt and SHA-256(salt+pin)", async () => {
  const secure = memorySecure();
  await setPin(secure, "123456", rnd, sha256);
  const salt = (await secure.get(SECURE_KEYS.pinSalt))!;
  const hash = (await secure.get(SECURE_KEYS.pinHash))!;
  expect(salt).toMatch(/^[0-9a-f]{32}$/);
  expect(hash).toBe((await sha256.digestHex(salt + "123456")));
  expect([...secure.data.values()].join(" ")).not.toContain("123456");
  expect([...secure.data.keys()].sort()).toEqual([SECURE_KEYS.pinHash, SECURE_KEYS.pinSalt].sort());
  expect(await hasPin(secure)).toBe(true);
});

test.each(["12345", "1234567", "12345a", "", " 123456", "１２３４５６"])("refuses %j: the PIN is exactly six digits", async (pin) => {
  const secure = memorySecure();
  await expect(setPin(secure, pin, rnd, sha256)).rejects.toBeInstanceOf(InvalidPinError);
  expect(secure.data.size).toBe(0);
  expect(PIN_LENGTH).toBe(6);
});

test("five wrong in a row lock, and the lock survives a restart", async () => {
  const secure = memorySecure();
  await setPin(secure, "123456", rnd, sha256);
  for (let i = 0; i < MAX_PIN_FAILURES - 1; i++) expect(await checkPin(secure, "000000", sha256)).toBe("wrong");
  expect(await checkPin(secure, "000000", sha256)).toBe("locked");
  expect(await checkPin(secure, "123456", sha256)).toBe("locked"); // the right PIN does not unlock
  const secureReloaded = memorySecure(Object.fromEntries(secure.data));
  expect(await isLocked(secureReloaded)).toBe(true);
  expect(await checkPin(secureReloaded, "123456", sha256)).toBe("locked");
});

test("a right PIN resets the failure count", async () => {
  const secure = memorySecure();
  await setPin(secure, "123456", rnd, sha256);
  for (let i = 0; i < 4; i++) expect(await checkPin(secure, "000000", sha256)).toBe("wrong");
  expect(await checkPin(secure, "123456", sha256)).toBe("ok");
  expect(await secure.get(SECURE_KEYS.pinFailures)).toBeNull();
  for (let i = 0; i < 4; i++) expect(await checkPin(secure, "000000", sha256)).toBe("wrong");
  expect(await isLocked(secure)).toBe(false);
});

test("a malformed attempt counts as wrong; without a PIN nothing gets in", async () => {
  const secure = memorySecure();
  expect(await checkPin(secure, "123456", sha256)).toBe("locked");
  await setPin(secure, "123456", rnd, sha256);
  expect(await checkPin(secure, "12345", sha256)).toBe("wrong");
  expect(await secure.get(SECURE_KEYS.pinFailures)).toBe("1");
});

test("a new PIN clears the lock and the failures (device registered again)", async () => {
  const secure = memorySecure();
  await setPin(secure, "123456", rnd, sha256);
  for (let i = 0; i < MAX_PIN_FAILURES; i++) await checkPin(secure, "000000", sha256);
  expect(await isLocked(secure)).toBe(true);
  await setPin(secure, "654321", rnd, sha256);
  expect(await isLocked(secure)).toBe(false);
  expect(await checkPin(secure, "654321", sha256)).toBe("ok");
  expect(await checkPin(secure, "123456", sha256)).toBe("wrong");
});
