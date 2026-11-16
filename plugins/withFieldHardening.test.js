/* global test, expect, describe */
const {
  applyMainActivity,
  applyManifest,
  networkSecurityXml,
  NO_BACKUP_XML,
  resolveOptions,
} = require("./withFieldHardening");

// MainActivity.kt as the Expo SDK 58 template generates it (trimmed).
const SAMPLE_KT = `package br.rotasaude.campo

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }
}
`;

function sampleManifest() {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [
        {
          $: {
            "android:name": ".MainApplication",
            "android:allowBackup": "true",
            "android:fullBackupContent": "@xml/secure_store_backup_rules",
            "android:dataExtractionRules": "@xml/secure_store_data_extraction_rules",
          },
        },
      ],
    },
  };
}

describe("MainActivity", () => {
  test("injects FLAG_SECURE before super.onCreate", () => {
    const out = applyMainActivity(SAMPLE_KT);
    expect(out).toMatch(/FLAG_SECURE[\s\S]*super\.onCreate/);
    expect(out).toMatch(/^import android\.view\.WindowManager$/m);
    expect(out).toContain(
      "window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)",
    );
  });

  test("is idempotent", () => {
    const once = applyMainActivity(SAMPLE_KT);
    expect(applyMainActivity(once)).toBe(once);
    expect(once.match(/setFlags/g)).toHaveLength(1);
    expect(once.match(/import android\.view\.WindowManager/g)).toHaveLength(1);
  });

  test("fails loudly when the template has no super.onCreate to anchor on", () => {
    expect(() => applyMainActivity("class MainActivity : ReactActivity() {}")).toThrow(/super\.onCreate/);
  });

  test("leaves the activity untouched only when screen capture is allowed", () => {
    expect(applyMainActivity(SAMPLE_KT, { allowScreenCapture: true })).toBe(SAMPLE_KT);
  });
});

describe("options", () => {
  test("screen capture is refused outside the e2e build", () => {
    expect(() => resolveOptions({ allowScreenCapture: true })).toThrow(/e2e/);
    expect(resolveOptions({ e2e: true, allowScreenCapture: true }).allowScreenCapture).toBe(true);
  });

  test("defaults are the production ones", () => {
    expect(resolveOptions(undefined)).toEqual({ e2e: false, devCleartextHosts: [], allowScreenCapture: false });
  });

  test("a cleartext host must be a bare host name or address", () => {
    expect(() => resolveOptions({ e2e: true, devCleartextHosts: ['10.0.2.2"/><x '] })).toThrow(/host/);
    expect(() => resolveOptions({ e2e: true, devCleartextHosts: ["http://10.0.2.2"] })).toThrow(/host/);
  });
});

describe("manifest", () => {
  test("turns backup and data extraction off and pins the network config", () => {
    const app = applyManifest(sampleManifest()).manifest.application[0].$;
    expect(app["android:allowBackup"]).toBe("false");
    expect(app["android:fullBackupContent"]).toBe("false");
    expect(app["android:dataExtractionRules"]).toBe("@xml/campo_no_backup");
    expect(app["android:networkSecurityConfig"]).toBe("@xml/campo_network_security");
    expect(app["android:usesCleartextTraffic"]).toBe("false");
  });

  test("backup rules exclude every domain from cloud backup and device transfer", () => {
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = NO_BACKUP_XML.split(`<${section}>`)[1].split(`</${section}>`)[0];
      for (const domain of ["root", "file", "database", "sharedpref", "external"]) {
        expect(body).toContain(`<exclude domain="${domain}" path="."/>`);
      }
      expect(body).not.toContain("<include");
    }
  });
});

describe("network security config", () => {
  test("production network config forbids cleartext everywhere", () => {
    const xml = networkSecurityXml([]);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
    expect(xml).not.toContain("domain-config");
    expect(xml).not.toMatch(/cleartextTrafficPermitted="true"/);
    expect(xml).not.toContain('src="user"');
  });

  test("e2e allows cleartext only to 10.0.2.2 (Q48)", () => {
    const xml = networkSecurityXml(["10.0.2.2"]);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
    expect(xml.match(/cleartextTrafficPermitted="true"/g)).toHaveLength(1);
    expect(xml.match(/<domain /g)).toHaveLength(1);
    expect(xml).toContain('<domain includeSubdomains="false">10.0.2.2</domain>');
  });
});
