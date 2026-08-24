/**
 * Précompile les routes app en hit HTTP (à lancer après `npm run dev`).
 * Usage: npm run dev:warm
 */
const BASE = process.env.WARM_BASE_URL ?? "http://127.0.0.1:3000";

const paths = [
  "/dashboard",
  "/clients",
  "/invoices",
  "/banque",
  "/inbox",
  "/settings",
  "/payments",
  "/api/dashboard?scope=month",
  "/api/urssaf/declarations",
  "/api/emails",
  "/api/settings",
];

async function warm(path: string) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      redirect: "manual",
      headers: { Accept: "text/html,application/json" },
    });
    console.log(`${res.status} ${path} — ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`ERR ${path} — ${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  console.log(`Warm-up ${BASE}…`);
  for (const p of paths) {
    await warm(p);
  }
  console.log("Done. Navigations suivantes devraient être rapides.");
}

main();
