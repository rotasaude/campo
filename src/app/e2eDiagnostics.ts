// e2e builds only: the probe of the diagnostics screen. It copies the database
// file and opens the COPY with no key at all. On a build with the cipher that
// cannot work — the first read fails ("file is not a database"). The copy is
// erased whatever happens. Like devicePlatform.tsx, this can only be proved on
// a device; it is loaded by `require` behind the literal EXPO_PUBLIC_E2E flag.
import * as LegacyFs from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import { DB_NAME } from "../db/open";
import type { ProbeResult } from "../features/diagnostics/DiagnosticsScreen";

const COPY_NAME = "campo-probe.db";

export async function probeWithoutKey(): Promise<ProbeResult> {
  const directory = `${LegacyFs.documentDirectory ?? ""}SQLite/`;
  const copy = directory + COPY_NAME;
  await LegacyFs.deleteAsync(copy, { idempotent: true });
  await LegacyFs.copyAsync({ from: directory + DB_NAME, to: copy });
  let opened: SQLite.SQLiteDatabase | null = null;
  try {
    // A new connection of its own: never the app's, which holds the key.
    opened = await SQLite.openDatabaseAsync(COPY_NAME, { useNewConnection: true });
    await opened.getFirstAsync("SELECT count(*) FROM sqlite_master");
    return "opened";
  } catch {
    return "refused";
  } finally {
    await opened?.closeAsync().catch(() => undefined);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await LegacyFs.deleteAsync(copy + suffix, { idempotent: true }).catch(() => undefined);
  }
}
