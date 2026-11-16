#!/usr/bin/env node
// Proves, on the built APK, what the configuration promises (module 24c, Task 23; Q44, Q48).
//
//   node scripts/check-apk.mjs <apk> [--e2e] [--suffixes .a.example,.b.example]
//                                    [--cert-sha256 <hex>] [--allow-screen-capture]
//
// Production (default):
//   - permissions are exactly the five of the app plus the signature permission AGP generates;
//   - backup and data extraction are off, the app is not debuggable nor test-only;
//   - cleartext traffic is forbidden everywhere and user certificates are not trusted;
//   - the activity sets FLAG_SECURE;
//   - the embedded config is not e2e, has no dev origin and carries the host suffixes of the
//     build (--suffixes, or CAMPO_ALLOWED_HOST_SUFFIXES), never ".localhost" or ".test";
//   - the JS bundle has none of the e2e entry points;
//   - the APK is signed with the upload key: the SHA-256 of its certificate is the one given
//     in --cert-sha256 or CAMPO_UPLOAD_CERT_SHA256 (a public fingerprint, not a secret; Q68).
// --e2e checks the e2e variant instead: cleartext only to 10.0.2.2, config marked e2e.
//
// Needs the Android SDK (ANDROID_HOME) and a JDK (JAVA_HOME or java on the PATH), and `unzip`.
// Exit code 0 when everything holds; 1 with the list of what failed; 2 on a usage or tool error.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_ID = "br.rotasaude.campo";
const PERMISSIONS = [
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.CAMERA",
  "android.permission.INTERNET",
  `${APP_ID}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
];
const E2E_CLEARTEXT_HOSTS = ["10.0.2.2"];
// Entry points that exist only in the e2e build (Q48).
const E2E_ONLY_STRINGS = ["10.0.2.2", "Colar código", "sem chave:"];
const TEST_SUFFIX = /\.(localhost|test)$/;
const FLAG_SECURE = 0x2000;

class ToolError extends Error {}

function usage(message) {
  process.stderr.write(
    `${message}\nuso: node scripts/check-apk.mjs <apk> [--e2e] [--suffixes .a.example,.b.example] [--cert-sha256 <hex>] [--allow-screen-capture]\n`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { apk: null, e2e: false, allowScreenCapture: false, suffixes: null, certSha256: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--e2e") options.e2e = true;
    else if (arg === "--allow-screen-capture") options.allowScreenCapture = true;
    else if (arg === "--suffixes") options.suffixes = argv[++i] ?? usage("--suffixes pede a lista");
    else if (arg === "--cert-sha256") options.certSha256 = argv[++i] ?? usage("--cert-sha256 pede a impressão digital");
    else if (arg.startsWith("--")) usage(`opção desconhecida: ${arg}`);
    else if (options.apk === null) options.apk = arg;
    else usage(`argumento a mais: ${arg}`);
  }
  if (options.apk === null) usage("falta o caminho do APK");
  if (!existsSync(options.apk)) usage(`APK não encontrado: ${options.apk}`);
  if (options.allowScreenCapture && !options.e2e) usage("--allow-screen-capture só vale com --e2e");
  const fingerprint = (options.certSha256 ?? process.env.CAMPO_UPLOAD_CERT_SHA256 ?? "").replaceAll(":", "").trim().toLowerCase();
  if (fingerprint !== "" && !/^[0-9a-f]{64}$/.test(fingerprint)) usage("impressão digital SHA-256 inválida (64 hex)");
  options.certSha256 = fingerprint === "" ? null : fingerprint;
  const raw = options.suffixes ?? process.env.CAMPO_ALLOWED_HOST_SUFFIXES ?? null;
  options.suffixes =
    raw === null
      ? null
      : raw
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
  return options;
}

function sdkTools() {
  const sdk = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
  ].find((dir) => dir && existsSync(dir));
  if (!sdk) throw new ToolError("SDK do Android não encontrado: defina ANDROID_HOME");
  const apkanalyzer = join(sdk, "cmdline-tools/latest/bin/apkanalyzer");
  const buildToolsDir = join(sdk, "build-tools");
  const versions = existsSync(buildToolsDir)
    ? readdirSync(buildToolsDir).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    : [];
  const buildTools = versions.length ? join(buildToolsDir, versions[versions.length - 1]) : null;
  for (const tool of [apkanalyzer, buildTools && join(buildTools, "aapt2"), buildTools && join(buildTools, "apksigner")]) {
    if (!tool || !existsSync(tool)) throw new ToolError(`ferramenta do SDK ausente: ${tool ?? "build-tools"}`);
  }
  return { apkanalyzer, aapt2: join(buildTools, "aapt2"), apksigner: join(buildTools, "apksigner") };
}

function run(file, args, { binary = false } = {}) {
  try {
    return execFileSync(file, args, {
      encoding: binary ? "buffer" : "utf8",
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString().trim().split("\n").slice(-3).join(" | ") : error.message;
    throw new ToolError(`${file.split("/").pop()} ${args.slice(0, 3).join(" ")} falhou: ${stderr}`);
  }
}

// Text of one APK entry, or null when the entry does not exist.
function entry(apk, name) {
  try {
    return execFileSync("unzip", ["-p", apk, name], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error.code === "ENOENT") throw new ToolError("unzip não encontrado");
    return null;
  }
}

// A string of the bundle is ASCII or UTF-16 in Hermes bytecode and UTF-8 in a plain bundle.
function containsText(buffer, text) {
  return ["utf8", "utf16le", "latin1"].some((encoding) => buffer.includes(Buffer.from(text, encoding)));
}

function checkPermissions(tools, apk, failures) {
  const found = run(tools.apkanalyzer, ["manifest", "permissions", apk])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const extra = found.filter((name) => !PERMISSIONS.includes(name));
  const missing = PERMISSIONS.filter((name) => !found.includes(name));
  if (extra.length) failures.push(`permissão a mais: ${extra.join(", ")}`);
  if (missing.length) failures.push(`permissão faltando: ${missing.join(", ")}`);
}

function checkManifest(tools, apk, failures) {
  const manifest = run(tools.apkanalyzer, ["manifest", "print", apk]);
  const application = /<application\b[^>]*>/.exec(manifest)?.[0];
  if (!application) return failures.push("manifesto sem <application>");
  const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(application)?.[1];
  if (!new RegExp(`package="${APP_ID.replaceAll(".", "\\.")}"`).test(manifest)) failures.push(`pacote diferente de ${APP_ID}`);
  if (attribute("android:allowBackup") !== "false") failures.push('android:allowBackup não é "false"');
  if (attribute("android:fullBackupContent") !== "false") failures.push('android:fullBackupContent não é "false"');
  if (!attribute("android:dataExtractionRules")) failures.push("android:dataExtractionRules ausente");
  if (!attribute("android:networkSecurityConfig")) failures.push("android:networkSecurityConfig ausente");
  if (attribute("android:usesCleartextTraffic") === "true") failures.push('android:usesCleartextTraffic é "true"');
  if (attribute("android:debuggable") === "true") failures.push("o app é debuggable");
  if (attribute("android:testOnly") === "true") failures.push("o app é testOnly");
}

// Path of a res/xml file inside the APK (AGP may shorten resource paths in release).
function resourceFile(tools, apk, name) {
  const dump = run(tools.aapt2, ["dump", "resources", apk]);
  const at = dump.search(new RegExp(`\\bxml/${name}\\b`));
  if (at < 0) return null;
  return /\(file\)\s+(\S+)/.exec(dump.slice(at))?.[1] ?? null;
}

function xmlTree(tools, apk, name) {
  const file = resourceFile(tools, apk, name);
  return file ? run(tools.aapt2, ["dump", "xmltree", apk, "--file", file]) : null;
}

function checkNetwork(tools, apk, e2e, failures) {
  const tree = xmlTree(tools, apk, "campo_network_security");
  if (tree === null) return failures.push("res/xml/campo_network_security ausente");
  const base = /E: base-config[^\n]*\n\s*A: [^\n]*cleartextTrafficPermitted[^\n]*/.exec(tree)?.[0] ?? "";
  if (!/cleartextTrafficPermitted[^\n]*false/.test(base)) failures.push("base-config não proíbe tráfego sem TLS");
  if (/A: [^\n]*src[^\n]*"user"/.test(tree)) failures.push("certificados do usuário são aceitos");
  const hosts = [...tree.matchAll(/^\s*T: '([^']*)'/gm)].map((match) => match[1].trim()).filter(Boolean).sort();
  const expected = e2e ? E2E_CLEARTEXT_HOSTS : [];
  if (hosts.join(",") !== expected.join(",")) {
    failures.push(`hosts sem TLS: [${hosts.join(", ")}], esperado [${expected.join(", ")}]`);
  }
  const permitted = (tree.match(/cleartextTrafficPermitted[^\n]*true/g) ?? []).length;
  if (permitted !== (e2e ? 1 : 0)) failures.push(`${permitted} bloco(s) liberam tráfego sem TLS`);
}

function checkBackupRules(tools, apk, failures) {
  const tree = xmlTree(tools, apk, "campo_no_backup");
  if (tree === null) return failures.push("res/xml/campo_no_backup ausente");
  if (/E: include\b/.test(tree)) failures.push("regras de backup incluem algum caminho");
  for (const section of ["cloud-backup", "device-transfer"]) {
    if (!new RegExp(`E: ${section}\\b`).test(tree)) failures.push(`regras de backup sem <${section}>`);
  }
  const excludes = (tree.match(/E: exclude\b/g) ?? []).length;
  if (excludes < 10) failures.push(`regras de backup com ${excludes} exclusões, esperado 10`);
}

function checkScreen(tools, apk, allowScreenCapture, failures) {
  const smali = run(tools.apkanalyzer, ["dex", "code", "--class", `${APP_ID}.MainActivity`, "--method", "onCreate(Landroid/os/Bundle;)V", apk]);
  const flag = new RegExp(`const(/\\w+)? \\w+, 0x${FLAG_SECURE.toString(16)}\\b`).test(smali);
  const secure = flag && /Landroid\/view\/Window;->setFlags\(II\)V/.test(smali);
  if (!secure && !allowScreenCapture) failures.push("MainActivity não liga FLAG_SECURE");
  if (secure && allowScreenCapture) failures.push("FLAG_SECURE ligada num build pedido com captura de tela");
}

function checkEmbeddedConfig(apk, { e2e, suffixes }, failures) {
  const raw = entry(apk, "assets/app.config");
  if (raw === null) return failures.push("assets/app.config ausente");
  let extra;
  try {
    extra = JSON.parse(raw.toString("utf8")).extra ?? {};
  } catch {
    return failures.push("assets/app.config não é JSON");
  }
  const embedded = Array.isArray(extra.allowedHostSuffixes) ? [...extra.allowedHostSuffixes].sort() : [];
  if (extra.e2e !== e2e) failures.push(`configuração embutida com e2e = ${JSON.stringify(extra.e2e)}`);
  if (!e2e && extra.devOrigin !== undefined) failures.push("configuração de produção com origem de desenvolvimento");
  if (embedded.length === 0) failures.push("lista de sufixos de host vazia");
  if (!e2e) {
    const test = embedded.filter((suffix) => TEST_SUFFIX.test(suffix) || !suffix.startsWith("."));
    if (test.length) failures.push(`sufixo de host que não vale em produção: ${test.join(", ")}`);
  }
  if (suffixes !== null && embedded.join(",") !== [...suffixes].sort().join(",")) {
    failures.push(`sufixos embutidos [${embedded.join(", ")}] diferentes dos do build [${suffixes.join(", ")}]`);
  }
}

function checkBundle(apk, e2e, failures) {
  const bundle = entry(apk, "assets/index.android.bundle");
  if (bundle === null) return failures.push("assets/index.android.bundle ausente: o APK não leva o JS embutido");
  if (e2e) return;
  for (const text of E2E_ONLY_STRINGS) {
    if (containsText(bundle, text)) failures.push(`o JS de produção contém "${text}" (só do build e2e)`);
  }
}

function checkSignature(tools, apk, { e2e, certSha256 }, failures) {
  let certs;
  try {
    certs = run(tools.apksigner, ["verify", "--print-certs", apk]);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return failures.push("o APK não está assinado ou a assinatura não confere");
  }
  if (!/certificate DN:/.test(certs)) failures.push("o APK não está assinado");
  if (e2e) return;
  if (/CN=Android Debug/i.test(certs)) failures.push("APK de produção assinado com a chave de debug");
  const digests = [...certs.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/gi)].map((match) => match[1].toLowerCase());
  if (certSha256 === null) {
    failures.push("falta a impressão digital da chave de envio (--cert-sha256 ou CAMPO_UPLOAD_CERT_SHA256)");
  } else if (digests.length !== 1 || digests[0] !== certSha256) {
    failures.push("o APK de produção não está assinado com a chave de envio");
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const tools = sdkTools();
  const failures = [];
  checkPermissions(tools, options.apk, failures);
  checkManifest(tools, options.apk, failures);
  checkNetwork(tools, options.apk, options.e2e, failures);
  checkBackupRules(tools, options.apk, failures);
  checkScreen(tools, options.apk, options.allowScreenCapture, failures);
  checkEmbeddedConfig(options.apk, options, failures);
  checkBundle(options.apk, options.e2e, failures);
  checkSignature(tools, options.apk, options, failures);

  const variant = options.e2e ? "e2e" : "produção";
  if (failures.length) {
    process.stderr.write(`check-apk (${variant}): ${failures.length} falha(s)\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-apk (${variant}): ok\n`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof ToolError)) throw error;
  process.stderr.write(`check-apk: ${error.message}\n`);
  process.exit(2);
}
