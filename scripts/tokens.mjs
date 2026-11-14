#!/usr/bin/env node
// Generates src/theme/tokens.ts from the design tokens of the contracts repo
// at a ref (tag): the colour roles of the themes the app uses — govbr (light)
// and govbr-escuro (dark). The app follows the system's light or dark.
// Usage: node scripts/tokens.mjs tokens-v1.1.0 --contracts ../../contracts
// GIT=/opt/homebrew/bin/git when the git of the PATH does not work.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const ref = args[0];
const at = args.indexOf("--contracts");
if (!ref || at < 0 || !args[at + 1]) {
  process.stderr.write("uso: node scripts/tokens.mjs <ref> --contracts <caminho do clone do contracts>\n");
  process.exit(1);
}
const git = process.env.GIT || "git";
const css = execFileSync(git, ["-C", resolve(args[at + 1]), "show", `${ref}:design-tokens/dist/tokens.css`], { encoding: "utf8" });

// The block of a theme: `:root[data-theme="<name>"] { --role: value; … }` (the default theme is also listed with :root:not([data-theme])).
function theme(name) {
  const block = new RegExp(`\\[data-theme="${name}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!block) throw new Error(`tema ${name} ausente em tokens.css`);
  const colors = {};
  for (const [, role, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) colors[role] = value.toLowerCase();
  return colors;
}

const themes = { light: theme("govbr"), dark: theme("govbr-escuro") };
const roles = Object.keys(themes.light).sort();
if (roles.length === 0 || JSON.stringify(roles) !== JSON.stringify(Object.keys(themes.dark).sort())) throw new Error("os dois temas não têm os mesmos papéis de cor");

const sha = createHash("sha256").update(css).digest("hex");
const body = `// gerado por scripts/tokens.mjs de design-tokens/dist/tokens.css (${ref}, sha256 ${sha}) — não editar.
export const TOKENS_REF = ${JSON.stringify(ref)};
export const COLOR_ROLES = ${JSON.stringify(roles)} as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
export type Palette = Record<ColorRole, string>;
export const PALETTES: { light: Palette; dark: Palette } = ${JSON.stringify(themes, null, 2)};
`;
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src/theme/tokens.ts");
writeFileSync(target, body);
process.stdout.write(`tokens ${ref}: ${roles.length} papéis de cor em src/theme/tokens.ts\n`);
