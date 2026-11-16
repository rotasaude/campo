# Build de release do app de campo

Como gerar, conferir e assinar o APK do Rota Saúde Campo. Tudo aqui roda numa máquina de desenvolvimento, com `expo prebuild` e Gradle local (sem EAS Build).

O que este documento **não** cobre ainda, porque depende de coisas que não existem: a chave de envio de verdade, os hosts de produção e a publicação no Google Play gerenciado (ADR 0053). Veja "O que falta" no fim.

## Ambiente

- JDK 21, Node 22, Android SDK com Build-Tools e `cmdline-tools` (o `check-apk` usa `apkanalyzer`, `aapt2` e `apksigner`).
- `JAVA_HOME` e `ANDROID_HOME` exportados no shell do build.
- `npm ci` feito. A pasta `android/` é gerada pelo `expo prebuild` e não entra no repositório.

## As três variantes

| | Produção | e2e | Desenvolvimento |
|---|---|---|---|
| Como se pede | nenhuma variável de variante | `EXPO_PUBLIC_E2E=1` | `APP_VARIANT=development` |
| Hosts do QR (`CAMPO_ALLOWED_HOST_SUFFIXES`) | obrigatório; recusa `.localhost`, `.test` e sufixo de um rótulo só | qualquer sufixo válido | qualquer sufixo válido |
| Tráfego sem TLS | proibido | só `10.0.2.2` | `10.0.2.2` e `localhost` |
| Origem de desenvolvimento (`EXPO_PUBLIC_DEV_ORIGIN`) | ignorada | usada | usada |
| "Colar código" e tela de Diagnóstico | não existem no bundle | existem | não existem |
| Chave de assinatura (propriedades do Gradle) | `CAMPO_UPLOAD_*` | `CAMPO_E2E_*` | a de debug do Android |
| `FLAG_SECURE` | sempre | sempre, salvo `CAMPO_E2E_SCREEN_CAPTURE=1` | sempre |

Um sufixo de host tem a forma `.dominio.example`, com o ponto na frente. Vários, separados por vírgula.

A chave de envio nunca assina um APK e2e: com o mesmo pacote e a mesma assinatura, um APK de teste atualizaria o app de produção por cima.

## Build de produção

```bash
export CAMPO_ALLOWED_HOST_SUFFIXES=.<host de produção>
npx expo prebuild --platform android --clean --no-install
(cd android && ./gradlew :app:assembleRelease)
node scripts/check-apk.mjs android/app/build/outputs/apk/release/app-release.apk \
  --suffixes "$CAMPO_ALLOWED_HOST_SUFFIXES" --cert-sha256 <impressão digital da chave de envio>
```

Use `--clean` sempre que trocar de variante: o `prebuild` sem ele mantém o bloco de assinatura e a `MainActivity` da variante anterior.

A variável `CAMPO_ALLOWED_HOST_SUFFIXES` precisa estar no ambiente do `./gradlew` também, porque é nele que o JS e a configuração embutida são empacotados.

### Chave de assinatura

As quatro propriedades ficam em `~/.gradle/gradle.properties`, fora do repositório:

```properties
CAMPO_UPLOAD_STORE_FILE=~/.rotasaude/campo-upload.jks
CAMPO_UPLOAD_STORE_PASSWORD=…
CAMPO_UPLOAD_KEY_ALIAS=…
CAMPO_UPLOAD_KEY_PASSWORD=…
```

Sem elas o build de release para em segundos com `chave de assinatura ausente: defina … em ~/.gradle/gradle.properties`. Nunca sai um APK assinado com a chave de debug. A senha não vai em linha de comando nem em arquivo do projeto.

A impressão digital do certificado é pública e pode ficar anotada aqui quando a chave existir:

```bash
keytool -list -v -keystore ~/.rotasaude/campo-upload.jks -alias <alias> | grep SHA256
```

O `check-apk` aceita a impressão em `--cert-sha256` ou na variável `CAMPO_UPLOAD_CERT_SHA256` (64 hex, sem os dois-pontos).

## Os portões do build

Os três primeiros foram vistos falhando num build de verdade; o último, nos testes do plugin:

| Situação | O que acontece |
|---|---|
| Produção sem `CAMPO_ALLOWED_HOST_SUFFIXES` | o `prebuild` para: `CAMPO_ALLOWED_HOST_SUFFIXES ausente: o build de release exige a lista de hosts do QR` |
| Produção com `.localhost` ou `.test` | o `prebuild` para: `… não vale no build de produção` |
| Release sem as propriedades da chave | o Gradle para: `chave de assinatura ausente: …` |
| `assets/map` incompleto (fonte, faixa de glifo ou sprite faltando) | o `prebuild` para, dizendo o que falta |

## O que o `check-apk` confere

`node scripts/check-apk.mjs <apk> [--e2e] [--suffixes …] [--cert-sha256 …] [--allow-screen-capture]` lê o próprio APK e sai com 0 (ok), 1 (lista do que falhou) ou 2 (uso ou ferramenta do SDK ausente):

- as permissões são exatamente câmera, localização precisa e aproximada, internet e estado da rede;
- sem backup (`allowBackup`, regras de backup e de transferência entre aparelhos) e sem `debuggable`;
- tráfego sem TLS: nenhum em produção; só `10.0.2.2` no e2e;
- `FLAG_SECURE` no código da `MainActivity`;
- a lista de hosts embutida é a do build, e nunca de teste em produção;
- o JS de produção não leva "Colar código" nem "sem chave:";
- a assinatura: em produção, o certificado tem a impressão digital informada; nunca a chave de debug.

Um APK de uma variante julgado como a outra falha. É assim que se sabe que as checagens olham para o APK e não para o que o build disse ter feito.

## Build e2e (para o Maestro)

Está em `maestro/README.md`, com a chave descartável e o servidor falso.

## O que já foi provado e onde

No emulador API 34 de tablet (2560x1600), com o APK e2e contra o servidor falso e um APK de produção de ensaio (chave local descartável, sufixo `.rotasaude.example`):

- `check-apk` passa nos dois e falha em cada caso errado;
- janela com a flag de segurança, miniatura de apps recentes preta, pacote sem backup e sem depuração;
- banco cifrado em disco (SQLCipher 4.17.0), sem cabeçalho de SQLite nem texto em claro;
- mapa offline desenhando do arquivo local, com fontes e ícones que vêm do APK;
- os onze fluxos do Maestro, numa mesma rodada (`maestro/README.md`).

## O que falta

- **Chave de envio de verdade**: gerar, guardar fora do repositório e anotar aqui a impressão digital. O mecanismo está provado com uma chave de ensaio.
- **Hosts de produção**: o valor de `CAMPO_ALLOWED_HOST_SUFFIXES`.
- **Distribuição**: Google Play gerenciado, app privado, um app para todas as cidades (ADR 0053). O runbook `operacao/rollout-app-de-campo.md`, no repositório `docs`, só pode ser escrito e provado quando houver conta. O Play pede AAB (`./gradlew :app:bundleRelease`); esse caminho ainda não foi exercitado.
- **Aparelho físico**: leitura de um QR pela câmera e GPS real. No emulador a câmera abre e o GPS responde por um provedor de teste.
- **CI**: um job que rode os fluxos do Maestro. Só se prova com push; ainda não existe.
