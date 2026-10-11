// make app : API en mode production locale sur :3000, qui sert l'admin compilé (apps/web/dist).
// Variables posées ici plutôt qu'en « VAR=x commande » dans le Makefile (syntaxe absente de cmd.exe).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = createRequire(path.join(root, "package.json")).resolve("tsx/cli");

const child = spawn(
  process.execPath,
  [tsxCli, "--env-file=.env", "--tsconfig", "apps/api/tsconfig.json", "apps/api/src/index.ts"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      WEB_DIST: path.join(root, "apps/web/dist"),
      API_PORT: "3000",
      WEB_ORIGIN: "http://localhost:3000",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
