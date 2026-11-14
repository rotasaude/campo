# Maestro — fluxos ponta a ponta do app de campo

Os fluxos rodam num APK **release de variante e2e** (JS embutido, Q59), no emulador API 34, contra o servidor falso do contrato (`scripts/fake-field-server`). Ficam fora do `bin/test`.

O build e2e difere do de produção só no que o teste precisa (Q48):

| | Produção | e2e |
|---|---|---|
| Campo "Colar código" na leitura do QR | não existe | existe |
| Tela de diagnóstico da cifra | não existe | existe |
| Tráfego sem TLS | proibido | só para `10.0.2.2` |
| Sufixos de host do QR | os do runbook | `.localhost`, `.test` |
| Chave de assinatura | `CAMPO_UPLOAD_*` | `CAMPO_E2E_*` (descartável) |
| `FLAG_SECURE` | ligada | ligada (desligada só com `CAMPO_E2E_SCREEN_CAPTURE=1`, para gravar evidência) |

`node scripts/check-apk.mjs <apk>` prova que um APK de produção não leva nada da coluna e2e; `--e2e` confere a variante de teste.

## Rodar local

Ambiente: JDK 21, `ANDROID_HOME`, Maestro 2.x e um emulador API 34 `google_apis` ligado.

```bash
# 1. chave descartável (uma vez; fora do repositório)
keytool -genkeypair -keystore "$TMPDIR/campo-e2e.jks" -alias e2e -keyalg RSA -keysize 2048 \
  -validity 30 -storepass campo-e2e -keypass campo-e2e -dname "CN=campo e2e"

# 2. build e2e
EXPO_PUBLIC_E2E=1 EXPO_PUBLIC_DEV_ORIGIN=http://10.0.2.2:8787 CAMPO_ALLOWED_HOST_SUFFIXES=.localhost,.test \
  npx expo prebuild --platform android --clean
(cd android && ./gradlew assembleRelease \
  -PCAMPO_E2E_STORE_FILE="$TMPDIR/campo-e2e.jks" -PCAMPO_E2E_STORE_PASSWORD=campo-e2e \
  -PCAMPO_E2E_KEY_ALIAS=e2e -PCAMPO_E2E_KEY_PASSWORD=campo-e2e)
node scripts/check-apk.mjs android/app/build/outputs/apk/release/app-release.apk --e2e

# 3. servidor falso, instalação e fluxos
node scripts/fake-field-server/server.mjs --port 8787 &
adb install -r android/app/build/outputs/apk/release/app-release.apk
QR=$(node scripts/fake-field-server/qr.mjs curitiba.localhost)
MAESTRO_CLI_NO_ANALYTICS=1 maestro test -e QR_PAYLOAD="$QR" maestro/
```

As variáveis `EXPO_PUBLIC_E2E` e `EXPO_PUBLIC_DEV_ORIGIN` entram no JS quando o Gradle empacota: precisam estar no ambiente do `./gradlew` também (o bloco acima as passa só ao `prebuild`; exporte-as antes ou repita-as na linha do Gradle).

A senha da chave descartável aparece na linha de comando de propósito: ela só assina o APK de teste. A chave de envio (`CAMPO_UPLOAD_*`) nunca vai em linha de comando; fica em `~/.gradle/gradle.properties`.

## Servidor falso

`scripts/fake-field-server/server.mjs` responde as cinco rotas do `field-sync` v1.2.0 a partir dos exemplos do contrato (`contracts/field-sync`), valida cada resposta contra o esquema antes de enviar e escuta só em `127.0.0.1` (que o emulador alcança por `10.0.2.2`). Aceita qualquer token com a forma `rsf_…`; `qr.mjs <host>` gera um QR com token novo.

Os fluxos mudam o comportamento por `POST /__script` (uma vez só cada):

| Corpo | Efeito |
|---|---|
| `{ "next_upload": "stale_version", "current_patch": { … } }` | o próximo envio de domicílio, família ou cadastro que já existe volta `stale_version`, com a linha atual alterada pelo `current_patch` (JSON merge patch). Campo diferente do editado no tablet → a mescla resolve sozinha; o mesmo campo → conflito com escolha |
| `{ "next_upload": "rejected:<código>" }` | o próximo item volta `rejected` com o código |
| `{ "next_status": 401, "error": "device_revoked" }` | a próxima requisição recebe 401 e aquele token segue recusado; um QR novo funciona |
| `{ "next_status": 401, "error": "device_suspended" }` | idem, com a fila preservada no app (Q17) |

`POST /__reset` zera o estado; `GET /__state` conta os itens aceitos por tipo.

## Fluxos

Cada fluxo começa com `appId: br.rotasaude.campo`, `clearState`, o payload em "Colar código" (`${QR_PAYLOAD}`) e o PIN `123456` duas vezes. Entram quando as telas das Tasks 16–22 existirem:

| Arquivo | O que prova |
|---|---|
| `pairing.yaml` | cadastra o aparelho, cria o PIN, chega ao Início |
| `initial-load.yaml` | carga com progresso; "A visitar" maior que zero |
| `offline-visit.yaml` | modo avião, visita, "Pendentes de envio: 1"; volta a rede, sincroniza, zero |
| `household-family.yaml` | domicílio novo com ponto no mapa, morador novo, família nova; tudo aceito |
| `conflict-merge.yaml` | `stale_version` sem campo cruzado: volta sozinho e é aceito |
| `conflict-choice.yaml` | `stale_version` com campo cruzado: "Conflitos: 1", escolhe "No tablet", aceito |
| `revocation-manual.yaml` | `device_revoked`: volta ao cadastro, fila vazia |
| `revocation-suspended.yaml` | `device_suspended`: "Acesso suspenso"; novo QR do mesmo usuário envia a fila |
| `map.yaml` | mapa offline com "© OpenStreetMap" e o ponto do domicílio |
| `encryption.yaml` | Diagnóstico mostra a versão da cifra e "sem chave: recusado" |

Com `FLAG_SECURE` ligada as capturas de tela saem pretas; o Maestro lê a árvore de acessibilidade e não depende delas.
