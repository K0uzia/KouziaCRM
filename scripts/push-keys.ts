// Clés VAPID des notifications push : écrites dans le .env SI elles sont absentes, jamais remplacées.
// Usage : npm run push:keys -- [--env-file=/opt/kouziacrm/.env] [--subject=mailto:contact@kouzia.com]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { generateVapidKeys } from "../apps/api/src/lib/push/vapid";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const envFile = path.resolve(arg("env-file") ?? ".env");
const subject = arg("subject") ?? "mailto:contact@kouzia.com";

if (!existsSync(envFile)) {
  console.error(`Fichier introuvable : ${envFile}`);
  process.exit(1);
}
const content = readFileSync(envFile, "utf8");
const has = (key: string) => new RegExp(`^${key}=["']?[^"'\\s]+`, "m").test(content);

if (has("VAPID_PUBLIC_KEY") || has("VAPID_PRIVATE_KEY")) {
  console.log("Clés VAPID déjà configurées : ne pas régénérer (les appareils abonnés ne recevraient plus rien).");
  process.exit(0);
}
if (!/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("--subject doit commencer par mailto: ou https://");
  process.exit(1);
}

const keys = generateVapidKeys();
const lines = [
  "",
  "# Notifications push (Web Push) : générées par kouziactl push-keys. Ne pas régénérer ni versionner.",
  `VAPID_PUBLIC_KEY="${keys.publicKey}"`,
  `VAPID_PRIVATE_KEY="${keys.privateKey}"`,
  ...(has("VAPID_SUBJECT") ? [] : [`VAPID_SUBJECT="${subject}"`]),
  "",
];
appendFileSync(envFile, (content.endsWith("\n") ? "" : "\n") + lines.join("\n"));
console.log(`Clés VAPID ajoutées à ${envFile}.`);
console.log("IMPORTANT : la clé privée fait partie de la sauvegarde du .env. Si elle est perdue ou changée,");
console.log("chaque appareil devra réactiver les notifications. Redémarrez ensuite : kouziactl restart.");
