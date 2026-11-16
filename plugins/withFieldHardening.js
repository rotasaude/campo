// Android hardening of the field app (module 24c, Task 23):
// - FLAG_SECURE on the only activity: no screenshot, no screen recording, blank recents preview;
// - backup and device-to-device transfer off for every storage domain;
// - cleartext traffic off, except to the hosts a development or e2e build names (Q48).
// The pure functions are exported so Jest covers them without a prebuild.
const { AndroidConfig, withAndroidManifest, withDangerousMod, withMainActivity } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const NO_BACKUP_RES = "campo_no_backup";
const NETWORK_RES = "campo_network_security";
const DOMAINS = ["root", "file", "database", "sharedpref", "external"];
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const FLAG_SECURE_LINE =
  "window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)";

function excludes(indent) {
  return DOMAINS.map((domain) => `${indent}<exclude domain="${domain}" path="."/>`).join("\n");
}

// Android 12+ reads data-extraction-rules; older versions read fullBackupContent="false".
const NO_BACKUP_XML = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup>
${excludes("    ")}
  </cloud-backup>
  <device-transfer>
${excludes("    ")}
  </device-transfer>
</data-extraction-rules>
`;

function resolveOptions(options) {
  const { e2e = false, devCleartextHosts = [], allowScreenCapture = false } = options ?? {};
  if (allowScreenCapture && !e2e) {
    throw new Error("withFieldHardening: a captura de tela só pode ser liberada no build e2e");
  }
  for (const host of devCleartextHosts) {
    if (typeof host !== "string" || !HOST.test(host)) {
      throw new Error(`withFieldHardening: host sem TLS inválido: ${JSON.stringify(host)}`);
    }
  }
  return { e2e, devCleartextHosts, allowScreenCapture };
}

function applyMainActivity(source, { allowScreenCapture = false } = {}) {
  if (allowScreenCapture || source.includes(FLAG_SECURE_LINE)) return source;
  const anchor = /^([ \t]*)super\.onCreate\(/m;
  if (!anchor.test(source)) {
    throw new Error("withFieldHardening: MainActivity sem super.onCreate; o template do Expo mudou");
  }
  let out = source.replace(anchor, (line, indent) => `${indent}${FLAG_SECURE_LINE}\n${line}`);
  if (!/^import android\.view\.WindowManager$/m.test(out)) {
    if (!/^import android\.os\.Bundle$/m.test(out)) {
      throw new Error("withFieldHardening: MainActivity sem o import de Bundle; o template do Expo mudou");
    }
    out = out.replace(/^import android\.os\.Bundle$/m, "import android.os.Bundle\nimport android.view.WindowManager");
  }
  return out;
}

function applyManifest(androidManifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  application.$["android:allowBackup"] = "false";
  application.$["android:fullBackupContent"] = "false";
  application.$["android:dataExtractionRules"] = `@xml/${NO_BACKUP_RES}`;
  application.$["android:networkSecurityConfig"] = `@xml/${NETWORK_RES}`;
  application.$["android:usesCleartextTraffic"] = "false";
  return androidManifest;
}

function networkSecurityXml(cleartextHosts) {
  const domains = cleartextHosts.map((host) => `    <domain includeSubdomains="false">${host}</domain>`).join("\n");
  const exception = cleartextHosts.length
    ? `  <domain-config cleartextTrafficPermitted="true">\n${domains}\n  </domain-config>\n`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system"/>
    </trust-anchors>
  </base-config>
${exception}</network-security-config>
`;
}

function withFieldHardening(config, options) {
  const { devCleartextHosts, allowScreenCapture } = resolveOptions(options);

  config = withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== "kt") {
      throw new Error("withFieldHardening: MainActivity em Kotlin esperada");
    }
    cfg.modResults.contents = applyMainActivity(cfg.modResults.contents, { allowScreenCapture });
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyManifest(cfg.modResults);
    return cfg;
  });

  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res/xml");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${NO_BACKUP_RES}.xml`), NO_BACKUP_XML);
      fs.writeFileSync(path.join(dir, `${NETWORK_RES}.xml`), networkSecurityXml(devCleartextHosts));
      return cfg;
    },
  ]);
}

module.exports = withFieldHardening;
module.exports.applyMainActivity = applyMainActivity;
module.exports.applyManifest = applyManifest;
module.exports.networkSecurityXml = networkSecurityXml;
module.exports.resolveOptions = resolveOptions;
module.exports.NO_BACKUP_XML = NO_BACKUP_XML;
