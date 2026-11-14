// Release signing (module 24c, Task 25). The generated android/app/build.gradle signs the
// release with the debug key; this plugin points it to signingConfigs.release, read from Gradle
// properties that live in ~/.gradle/gradle.properties (never in the repository nor in android/,
// which `prebuild --clean` erases):
//
//   CAMPO_UPLOAD_STORE_FILE, CAMPO_UPLOAD_STORE_PASSWORD, CAMPO_UPLOAD_KEY_ALIAS, CAMPO_UPLOAD_KEY_PASSWORD
//
// Without them a release task fails with "chave de assinatura ausente"; it never falls back to
// the debug key. The e2e build reads CAMPO_E2E_* instead, so the upload key never signs an APK
// that carries the test entry points (Q48).
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// campo: release signing (plugins/withReleaseSigning.js)";
const FIELDS = ["STORE_FILE", "STORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD"];

function preamble(keys) {
  return `${MARKER}
def campoSigningKeys = [${keys.map((key) => `"${key}"`).join(", ")}]
def campoSigning = { String key -> (findProperty(key) ?: "").toString().trim() }
def campoSigningMissing = campoSigningKeys.findAll { campoSigning(it).isEmpty() }
gradle.taskGraph.whenReady { graph ->
    def releaseTask = graph.allTasks.any {
        it.project == project && it.name ==~ /(assemble|bundle|package|install|sign|validateSigning).*Release.*/
    }
    if (releaseTask && !campoSigningMissing.isEmpty()) {
        throw new GradleException("chave de assinatura ausente: defina " + campoSigningMissing.join(", ") + " em ~/.gradle/gradle.properties")
    }
}

`;
}

function releaseSigningConfig([storeFile, storePassword, keyAlias, keyPassword]) {
  return `
        release {
            if (campoSigningMissing.isEmpty()) {
                storeFile file(campoSigning("${storeFile}").replaceFirst(/^~/, System.getProperty("user.home")))
                storePassword campoSigning("${storePassword}")
                keyAlias campoSigning("${keyAlias}")
                keyPassword campoSigning("${keyPassword}")
            }
        }`;
}

function applySigning(buildGradle, { e2e = false } = {}) {
  if (buildGradle.includes(MARKER)) return buildGradle;
  const keys = FIELDS.map((field) => `CAMPO_${e2e ? "E2E" : "UPLOAD"}_${field}`);

  const releaseDebugKey = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[^}]*?signingConfig\s+)signingConfigs\.debug/;
  if (!releaseDebugKey.test(buildGradle)) {
    if (!/signingConfigs\s*\{/.test(buildGradle)) {
      throw new Error("withReleaseSigning: build.gradle sem signingConfigs; o template do Expo mudou");
    }
    throw new Error("withReleaseSigning: buildTypes.release sem signingConfig; o template do Expo mudou");
  }
  let out = buildGradle.replace(releaseDebugKey, "$1signingConfigs.release");

  if (!/signingConfigs\s*\{/.test(out) || !/^android\s*\{/m.test(out)) {
    throw new Error("withReleaseSigning: build.gradle sem signingConfigs; o template do Expo mudou");
  }
  out = out.replace(/signingConfigs\s*\{/, (opener) => opener + releaseSigningConfig(keys));
  return out.replace(/^android\s*\{/m, (opener) => preamble(keys) + opener);
}

function withReleaseSigning(config, options) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") {
      throw new Error("withReleaseSigning: build.gradle em Groovy esperado");
    }
    cfg.modResults.contents = applySigning(cfg.modResults.contents, options ?? {});
    return cfg;
  });
}

module.exports = withReleaseSigning;
module.exports.applySigning = applySigning;
