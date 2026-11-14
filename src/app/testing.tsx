// Test support for screens: fake services and a render that provides them.
import { render } from "@testing-library/react-native";
import type { ReactElement } from "react";
import type { Db } from "../db/types";
import { fixedRandom, memorySecure, sha256 } from "../security/testing";
import { ServicesProvider, type AppServices } from "./services";

let uuids = 0;

export function fakeServices(over: Partial<AppServices> & { db: Db }): AppServices & { secure: ReturnType<typeof memorySecure> } {
  const secure = (over.secure as ReturnType<typeof memorySecure> | undefined) ?? memorySecure();
  return {
    http: (async () => { throw new Error("no network in screen tests"); }) as unknown as AppServices["http"],
    fs: { documentDirectory: "file:///data/user/0/br.rotasaude.campo/files/", deleteAsync: async () => undefined },
    net: undefined, camera: undefined,
    // No position permission unless the test gives a port.
    location: { permission: async () => ({ granted: false, precise: false }), current: async () => { throw new Error("no position in screen tests"); } },
    crypto: { digestHex: sha256.digestHex, randomUUID: () => `00000000-0000-4000-9000-${(++uuids).toString(16).padStart(12, "0")}` },
    now: () => Date.parse("2026-11-14T15:00:00Z"),
    random: fixedRandom,
    ...over,
    secure,
  };
}

export function renderWithServices(ui: ReactElement, services: AppServices) {
  return render(<ServicesProvider value={services}>{ui}</ServicesProvider>);
}
