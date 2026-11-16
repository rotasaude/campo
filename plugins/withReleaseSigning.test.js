/* global test, expect, describe */
const { applySigning } = require("./withReleaseSigning");

// android/app/build.gradle as the Expo SDK 58 template generates it (trimmed).
const SAMPLE_GRADLE = `apply plugin: "com.android.application"

android {
    namespace "br.rotasaude.campo"
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

function block(src, opener) {
  const start = src.indexOf(opener);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced block: ${opener}`);
}

describe("applySigning", () => {
  test("release is signed by signingConfigs.release, never by the debug key", () => {
    const out = applySigning(SAMPLE_GRADLE);
    const release = block(block(out, "buildTypes {"), "release {");
    expect(release).toContain("signingConfig signingConfigs.release");
    expect(release).not.toContain("signingConfigs.debug");
    expect(block(block(out, "buildTypes {"), "debug {")).toContain("signingConfig signingConfigs.debug");
  });

  test("signingConfigs.release reads the four upload properties", () => {
    const signing = block(block(applySigning(SAMPLE_GRADLE), "signingConfigs {"), "release {");
    for (const key of [
      "CAMPO_UPLOAD_STORE_FILE",
      "CAMPO_UPLOAD_STORE_PASSWORD",
      "CAMPO_UPLOAD_KEY_ALIAS",
      "CAMPO_UPLOAD_KEY_PASSWORD",
    ]) {
      expect(signing).toContain(`campoSigning("${key}")`);
    }
  });

  test("without the properties a release task throws 'chave de assinatura ausente'", () => {
    const out = applySigning(SAMPLE_GRADLE);
    expect(out).toContain('throw new GradleException("chave de assinatura ausente: defina "');
    expect(out).toMatch(/taskGraph\.whenReady[\s\S]*Release[\s\S]*GradleException/);
  });

  test("the e2e build reads its own throwaway key, never the upload one (Q48)", () => {
    const out = applySigning(SAMPLE_GRADLE, { e2e: true });
    expect(out).toContain('"CAMPO_E2E_STORE_FILE"');
    expect(out).not.toContain("CAMPO_UPLOAD_");
  });

  test("carries no secret and no key path", () => {
    const out = applySigning(SAMPLE_GRADLE);
    expect(out).not.toMatch(/\.jks|\/\.rotasaude/);
    expect(out.match(/storePassword\s+'[^']*'/g)).toEqual(["storePassword 'android'"]);
  });

  test("is idempotent", () => {
    const once = applySigning(SAMPLE_GRADLE);
    expect(applySigning(once)).toBe(once);
  });

  test("fails loudly when the template changes shape", () => {
    expect(() => applySigning("android { }")).toThrow(/signingConfigs/);
    expect(() => applySigning(SAMPLE_GRADLE.replace("signingConfig signingConfigs.debug\n            minify", "minify"))).toThrow(
      /release/,
    );
  });
});
