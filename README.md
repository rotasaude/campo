# Rota Saúde Campo

App Android offline do agente comunitário de saúde e dos demais profissionais de campo do Rota Saúde: cadastro domiciliar, familiar e individual, visita domiciliar e atividade coletiva, com mapa local e sincronização pelo contrato `field-sync`.

O app nunca é fonte de verdade. Quem decide é o `api` do Rota Saúde; o tablet guarda uma cópia cifrada do território e uma fila de envio (ADR 0041 e ADR 0053, em `rotasaude/docs`).

## Stack (versões fixas)

| Peça | Versão |
|---|---|
| Expo SDK | 58.0.25 |
| React Native | 0.88.1 (nova arquitetura) |
| React | 19.3.0 |
| TypeScript | 6.0 (`strict`) |
| Expo Router | 58.0.31 |
| expo-sqlite (SQLCipher 4.17.0 community) | 58.0.17 |
| expo-secure-store | 58.0.3 |
| expo-file-system | 58.0.13 |
| expo-crypto | 58.0.8 |
| expo-network | 58.0.5 |
| expo-location | 58.0.22 |
| expo-camera | 58.0.14 |
| @maplibre/maplibre-react-native | 11.5.1 (MapLibre Native Android 13.6.1) |
| Jest / jest-expo | 30.5.2 / 58.0.14 |
| Node | 22 |
| JDK | 21 |

As versões dos pacotes Expo são as que o `npx expo install` escolhe para o SDK 58; `.npmrc` grava versões exatas.

## Regras do app

- Sem Expo Go e sem EAS Build: `expo prebuild` e Gradle local. A pasta `android/` é gerada e não entra no repositório.
- Um app para todas as cidades; a cidade vem do QR de cadastro do aparelho.
- Dado de pessoa só no banco local cifrado (SQLCipher). CPF e CNS nunca descem ao tablet.
- Log sem dado de pessoa: só `src/log.ts` escreve, e só nome do evento, `client_uuid`, tipo, código, `seq` e status HTTP.
- Sem SDK de telemetria, de falhas ou de mapa de terceiros. Nenhuma URL `http(s)` de terceiro.
- Módulos puros (`src/sync`, `src/rules`, `src/security`, `src/map`) não importam módulo nativo: recebem as portas por `AppServices` (`src/app/services.ts`).

## Flags de build

Lidas só em `app.config.ts`:

| Variável | Uso |
|---|---|
| `CAMPO_ALLOWED_HOST_SUFFIXES` | Sufixos de host aceitos no QR, separados por vírgula. Obrigatória no build de release: sem ela a configuração falha. |
| `APP_VARIANT=development` | Build de desenvolvimento. |
| `EXPO_PUBLIC_E2E=1` | Build de teste ponta a ponta. |
| `EXPO_PUBLIC_DEV_ORIGIN` | Origem do servidor; só vale em desenvolvimento e e2e. |

## Testes

Pelo executor do monorepo, nunca `jest` direto no host:

```
bin/test campo [-w <worktree>] [args do jest]
```

Roda o Jest 30 com `jest-expo` num container Node 22. A CI roda lint, checagem de tipos e Jest.

## Desenvolvimento

```
npm ci
npx eslint .
npx tsc --noEmit
```

O build local do APK, a assinatura e a distribuição ficam no runbook `operacao/rollout-app-de-campo.md` do `rotasaude/docs`.
