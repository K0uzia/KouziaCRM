// Mailpit en binaire local (.tools/), sans Docker ni bash : Windows (PowerShell, cmd, Git Bash),
// Linux et macOS. Remplace scripts/mailpit.sh, qui tombait sur le bash de WSL sous Windows.
//   node scripts/mailpit.mjs start | stop | status
import { spawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = path.join(root, ".tools");
const pidFile = path.join(tools, "mailpit.pid");
const logFile = path.join(tools, "mailpit.log");
const smtpPort = Number(process.env.MAILPIT_SMTP_PORT) || 1025;
const uiPort = Number(process.env.MAILPIT_UI_PORT) || 8025;
const isWindows = process.platform === "win32";
const bin = path.join(tools, isWindows ? "mailpit.exe" : "mailpit");

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(800);
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

async function ensureBinary() {
  if (existsSync(bin)) return;
  mkdirSync(tools, { recursive: true });
  const os = isWindows ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const archive = path.join(tools, `mailpit-${os}-${arch}.${isWindows ? "zip" : "tar.gz"}`);
  const url = `https://github.com/axllent/mailpit/releases/latest/download/${path.basename(archive)}`;
  console.log(`Téléchargement de Mailpit (${os} ${arch})…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // tar extrait aussi les .zip sous Windows 10+ (bsdtar fourni avec le système).
  const tar = isWindows ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", tools, path.basename(bin)], { stdio: "inherit" });
  rmSync(archive, { force: true });
  if (!existsSync(bin)) throw new Error(`Extraction échouée : ${bin} introuvable`);
}

function savedPid() {
  try {
    return Number(readFileSync(pidFile, "utf8").trim()) || null;
  } catch {
    return null;
  }
}

function printAddresses() {
  console.log(`Mailpit SMTP : 127.0.0.1:${smtpPort}`);
  console.log(`Mailpit UI   : http://127.0.0.1:${uiPort}`);
}

async function start() {
  if ((await portOpen(smtpPort)) || (await portOpen(uiPort))) {
    // Port pris : Mailpit déjà lancé (autre terminal, pile de démo) ou autre service.
    console.log(`Mailpit semble déjà actif (port ${smtpPort} ou ${uiPort} occupé) : rien à lancer.`);
    printAddresses();
    return;
  }
  await ensureBinary();
  const out = openSync(logFile, "a");
  const child = spawn(
    bin,
    ["--smtp", `127.0.0.1:${smtpPort}`, "--listen", `127.0.0.1:${uiPort}`, "--smtp-auth-accept-any", "--smtp-auth-allow-insecure"],
    { detached: true, stdio: ["ignore", out, out], windowsHide: true },
  );
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 20 && !(await portOpen(smtpPort)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await portOpen(smtpPort))) {
    console.error(`Échec du démarrage de Mailpit : voir ${logFile}`);
    process.exit(1);
  }
  printAddresses();
}

function stop() {
  const pid = savedPid();
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      /* déjà arrêté */
    }
  }
  rmSync(pidFile, { force: true });
  console.log("Mailpit arrêté");
}

const command = process.argv[2] ?? "start";
try {
  if (command === "start") await start();
  else if (command === "stop") stop();
  else if (command === "status") {
    const up = await portOpen(smtpPort);
    console.log(up ? "Mailpit actif" : "Mailpit arrêté");
    if (up) printAddresses();
  } else {
    console.error("Usage : node scripts/mailpit.mjs start|stop|status");
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
