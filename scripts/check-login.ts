// Connexion du compte admin de recette pour les contrôles Playwright (check:mobile, check:offline).
//   CHECK_MOBILE_EMAIL, CHECK_MOBILE_PASSWORD, CHECK_MOBILE_TOTP (secret base32, si 2FA activée)
import { createHmac } from "node:crypto";
import type { Page } from "playwright";

function totp(secretBase32: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/\s/g, "").toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const o = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

export async function login(page: Page, base: string) {
  const email = process.env.CHECK_MOBILE_EMAIL;
  const password = process.env.CHECK_MOBILE_PASSWORD;
  if (!email || !password) {
    throw new Error("CHECK_MOBILE_EMAIL et CHECK_MOBILE_PASSWORD requis (compte admin de la base de recette).");
  }
  await page.goto(`${base}/login`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  const code = page.getByLabel("Code", { exact: true });
  await Promise.race([page.waitForURL(`${base}/`), code.waitFor()]);
  if (await code.isVisible().catch(() => false)) {
    const secret = process.env.CHECK_MOBILE_TOTP;
    if (!secret) throw new Error("Double authentification active : CHECK_MOBILE_TOTP (secret base32) requis.");
    await code.fill(totp(secret));
    // Code complet : le formulaire part tout seul. « Valider » seulement s'il n'est pas parti.
    await page.waitForURL(`${base}/`, { timeout: 5000 }).catch(async () => {
      await page.getByRole("button", { name: "Valider" }).click();
      await page.waitForURL(`${base}/`);
    });
  }
}
