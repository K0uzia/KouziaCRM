/**
 * Trace de l'arrêt du processus (dette du serveur de test, 26/10/2026 : serveur de recette arrêté sans un mot en cours
 * de contrôle). Une ligne JSON sur stderr, écrite de façon synchrone, quelle que soit la cause : code de sortie, dernier
 * signal reçu, mémoire et durée de vie. Exception non gérée : journalisée avec la mémoire, puis arrêt (code 1, comme
 * Node). Un arrêt brutal de l'extérieur (SIGKILL, mémoire du système épuisée) n'écrit rien : le lanceur le constate
 * (scripts/with-test-server.mjs). KOUZIA_MEMORY_LOG_MS (1000 ms au moins) : relevé périodique de la mémoire.
 */

const mo = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

export function memorySnapshot() {
  const m = process.memoryUsage();
  return { rssMo: mo(m.rss), heapUsedMo: mo(m.heapUsed), heapTotalMo: mo(m.heapTotal), externalMo: mo(m.external), uptimeS: Math.round(process.uptime()) };
}

type Write = (line: string) => void;
const stderrLine: Write = (line) => process.stderr.write(`${line}\n`);

export function installExitDiagnostics(write: Write = stderrLine, env: NodeJS.ProcessEnv = process.env) {
  let lastSignal: string | null = null;
  const line = (level: number, msg: string, extra: Record<string, unknown> = {}) =>
    write(JSON.stringify({ level, time: Date.now(), pid: process.pid, msg, ...extra, ...memorySnapshot() }));

  process.on("uncaughtException", (err, origin) => {
    line(60, "[processus] exception non gérée : arrêt", { origin, err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    process.exit(1);
  });
  process.on("exit", (code) => {
    line(code === 0 ? 30 : 50, `[processus] arrêt, code ${code}${lastSignal ? ` après ${lastSignal}` : ""}`, { code, signal: lastSignal });
  });

  const every = Number(env.KOUZIA_MEMORY_LOG_MS);
  if (Number.isFinite(every) && every >= 1000) setInterval(() => line(30, "[processus] mémoire"), every).unref();

  return {
    /** Signal reçu (SIGTERM, SIGINT…) : rappelé dans la ligne d'arrêt. */
    noteSignal(signal: string) {
      lastSignal = signal;
    },
  };
}
