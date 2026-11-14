#!/usr/bin/env node
// Copies map-style/dist of the contracts repo, at a ref (tag), to assets/map
// and writes assets/map/map-style.lock (ref + SHA-256 per file). Both themes,
// every font stack and every sprite: the Android build copies fonts/ and
// sprites/ into the APK's assets (plugins/withMapAssets.js) and fails if
// anything is missing.
// Usage: node scripts/map-style-sync.mjs map-style-v1.0.0 --contracts ../../contracts
// GIT=/opt/homebrew/bin/git when the git of the PATH does not work.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const ref = args[0];
const at = args.indexOf("--contracts");
if (!ref || at < 0 || !args[at + 1]) {
  process.stderr.write("uso: node scripts/map-style-sync.mjs <ref> --contracts <caminho do clone do contracts>\n");
  process.exit(1);
}
const contracts = resolve(args[at + 1]);
const git = process.env.GIT || "git";
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "assets/map");

const tmp = mkdtempSync(join(tmpdir(), "map-style-"));
const tar = execFileSync(git, ["-C", contracts, "archive", "--format=tar", ref, "map-style/dist"], { maxBuffer: 256 * 1024 * 1024 });
execFileSync("tar", ["-x", "-C", tmp], { input: tar, maxBuffer: 256 * 1024 * 1024 });

rmSync(target, { recursive: true, force: true });
cpSync(join(tmp, "map-style/dist"), target, { recursive: true });
rmSync(tmp, { recursive: true, force: true });

const list = (base) => readdirSync(base).flatMap((name) => {
  const full = join(base, name);
  return statSync(full).isDirectory() ? list(full) : [relative(target, full)];
});
const files = {};
for (const file of list(target).sort()) files[file] = createHash("sha256").update(readFileSync(join(target, file))).digest("hex");
writeFileSync(join(target, "map-style.lock"), JSON.stringify({ ref, files }, null, 2) + "\n");
process.stdout.write(`map-style ${ref} copiado para assets/map (${Object.keys(files).length} arquivos)\n`);
