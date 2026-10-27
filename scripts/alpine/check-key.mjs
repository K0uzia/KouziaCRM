// Contrôle de la clé de chiffrement de l'ERP (kouziactl restore) : lit sur l'entrée standard une valeur chiffrée de la
// base (base64 de IV 12 octets, tag 16 octets, données ; format de apps/api/src/lib/crypto.ts) et la clé dans la
// variable d'environnement KEY (64 caractères hexadécimaux). Code de sortie 0 si la clé la déchiffre, 1 sinon. N'affiche
// jamais la clé ni la donnée. Sans dépendance : tourne avant toute installation des modules.
import { createDecipheriv } from "node:crypto";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const payload = Buffer.concat(chunks).toString("utf8").trim();
const key = process.env.KEY ?? "";
if (!/^[0-9a-fA-F]{64}$/.test(key) || !payload) process.exit(1);
try {
  const buf = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  process.exit(0);
} catch {
  process.exit(1);
}
