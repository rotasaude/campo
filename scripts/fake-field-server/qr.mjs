#!/usr/bin/env node
// Prints a device QR payload for the fake field-sync server, with a random token nobody issued:
//   node scripts/fake-field-server/qr.mjs curitiba.localhost
// Same form as the dashboard's QR: "rotasaude-field:v1:" + base64url(JSON { host, token }).
// The e2e build pastes it in the "Colar código" field (Q48); every run gives a new token.
import { Buffer } from "node:buffer";
import { newToken } from "./state.mjs";

const HOST = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const host = process.argv[2] ?? "";

if (!HOST.test(host)) {
  process.stderr.write("uso: node scripts/fake-field-server/qr.mjs <host da cidade, ex.: curitiba.localhost>\n");
  process.exit(2);
}
const payload = Buffer.from(JSON.stringify({ host, token: newToken() })).toString("base64url");
process.stdout.write(`rotasaude-field:v1:${payload}\n`);
