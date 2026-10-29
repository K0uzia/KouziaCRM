import { execSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// kouziactl audit report (décision d'Alexandre du 28/10/2026) : rapport en lecture seule pour le superviseur, sans
// donnée personnelle des clients ni secret. Ces tests nourrissent le rapport de faux secrets et de fausses données
// personnelles, puis vérifient qu'aucune ne ressort, et que la base ne peut pas être écrite.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const LIB = pathToFileURL(path.join(ROOT, "scripts/alpine/audit-lib.mjs")).href;
const REPORT = path.join(ROOT, "scripts/alpine/audit-report.mjs");

type Lib = {
  maskText(s: string): string;
  maskFree(s: string, m?: (s: string) => string): string;
  nameTokens(v: string[]): string[];
  nameMasker(t: string[]): (s: string) => string;
  safeSettings(row: Record<string, unknown>, types: Record<string, string>): Record<string, unknown>;
  envPresence(env: string, example?: string): Record<string, string>;
  openReadOnly(p: string): { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(): unknown[] }; close(): void };
};
let lib: Lib;

// Fausses données : chacune ne doit jamais apparaître dans une sortie.
const SECRETS = {
  smtpPass: "Sm7pP4ss-Secret-2026",
  stripeKey: "sk_live_51Hx9YzAbCdEfGhIjKlMnOp",
  stripeWebhook: "whsec_9f8e7d6c5b4a3f2e1d0c",
  github: "github_pat_11ABCDEFG0123456789_abcdefghijk",
  iban: "FR76 3000 6000 0112 3456 7890 189",
  ibanCompact: "FR7630006000011234567890189",
  bic: "AGRIFRPP882",
  ownerEmail: "alexandre.perso@example.org",
  ownerPhone: "06 12 34 56 78",
  siret: "123 456 789 00012",
  hint: "…0189",
};
const CLIENT = { first: "Gwenaëlle", last: "Kerbrat", company: "Boulangerie Kerbrat", email: "gwen.kerbrat@exemple.bzh", phone: "+33 6 98 76 54 32", ip: "203.0.113.42", ipv6: "2a01:e0a:1b2:3c40::17", street: "12 rue du Pouliet" };
const ALL_FORBIDDEN = [...Object.values(SECRETS), CLIENT.first, CLIENT.last, CLIENT.company, CLIENT.email, CLIENT.phone, CLIENT.ip, CLIENT.ipv6, CLIENT.street];

let tmp: string;
let dbPath: string;
let logDir: string;
const ids: Record<string, string> = {};

const nodeArgs = ["--disable-warning=ExperimentalWarning", REPORT];
function runReport(extra: string[]) {
  return spawnSync(process.execPath, [...nodeArgs, "--app-dir", ROOT, "--db", dbPath, "--log-dir", logDir, ...extra], { encoding: "utf8" });
}
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

beforeAll(async () => {
  lib = (await import(LIB)) as Lib;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kouzia-audit-"));
  dbPath = path.join(tmp, "erp.db");
  logDir = path.join(tmp, "logs");
  fs.mkdirSync(logDir);
  // Schéma réel (prisma/schema.prisma), créé sans Prisma dans une base jetable.
  const sql = execSync("npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script", { cwd: ROOT, encoding: "utf8", shell: true as unknown as string });
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): Record<string, unknown>[] }; close(): void } };
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.exec(`CREATE TABLE "_prisma_migrations" (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, finished_at DATETIME, migration_name TEXT NOT NULL, logs TEXT, rolled_back_at DATETIME, started_at DATETIME NOT NULL DEFAULT current_timestamp, applied_steps_count INTEGER NOT NULL DEFAULT 0)`);
  const migDir = path.join(ROOT, "prisma/migrations");
  const migs = fs.readdirSync(migDir).filter((d) => fs.existsSync(path.join(migDir, d, "migration.sql"))).sort();
  for (const m of migs.slice(0, -1)) db.prepare(`INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name) VALUES (?, 'x', ?, ?)`).run(m, Date.now(), m);
  ids.lastMigration = migs.at(-1)!;

  // Insertion : colonnes obligatoires sans défaut remplies d'une valeur neutre (le schéma peut évoluer).
  const ins = (table: string, data: Record<string, unknown>) => {
    const cols = db.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS d, pk FROM pragma_table_info('${table}')`).all();
    const row: Record<string, unknown> = { ...data };
    for (const c of cols) {
      const name = String(c.name);
      if (name in row || !c.nn || c.d !== null) continue;
      const t = String(c.type);
      row[name] = name === "id" ? `${table.toLowerCase()}_${Math.random().toString(36).slice(2, 10)}` : t === "DATETIME" ? Date.now() : t === "TEXT" ? "x" : t === "JSONB" ? "{}" : 0;
    }
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k] as never));
    return String(row.id);
  };
  const DAY = 86400000;
  const now = Date.now();
  ins("CompanySettings", {
    id: "settings", legalName: "Kouzia", siren: "123456789", siret: SECRETS.siret, apeCode: "6201Z", addressLine1: "3 place des Otages", postalCode: "29600", city: "Morlaix",
    email: SECRETS.ownerEmail, phone: SECRETS.ownerPhone, smtpPassEncrypted: SECRETS.smtpPass, smtpPassHint: SECRETS.hint, smtpUser: SECRETS.ownerEmail,
    stripeSecretKeyEncrypted: SECRETS.stripeKey, stripeWebhookSecretEncrypted: SECRETS.stripeWebhook, githubTokenEncrypted: SECRETS.github,
    bankIban: SECRETS.iban, bankBic: SECRETS.bic, bankAccountHolder: "Alexandre Perso", obligationReminderEmail: SECRETS.ownerEmail,
    cgvPublished: 1, cgvVersion: "2026-11-04", invoiceNumberTemplate: "F-{year}-{counter}", moduleStripeEnabled: 1,
  });
  ins("LegalClause", { id: "clause_vat", kind: "VAT", title: "Franchise en base de TVA", body: "TVA non applicable, art. 293 B du CGI", required: 1, active: 1 });
  ids.pack = ins("Service", { id: "svc_pack", name: "Pack Vitrine", unitPriceCents: 140000, isPack: 1, annualPriceCents: 150000, category: null });
  ids.site = ins("Service", { id: "svc_site", name: "Site vitrine", unitPriceCents: 130000, category: "SITE" });
  ids.maint = ins("Service", { id: "svc_maint", name: "Maintenance", unitPriceCents: 2900, isSubscription: 1, billingInterval: "MONTH", buyoutServiceId: "svc_site", stripeProductId: "prod_maint", stripePriceId: "price_1", stripeLivemode: 0 });
  // Prestation supprimée de l'ERP : reste son produit Stripe (webhooks du catalogue) et un code promo qui la cite.
  const evt = (id: string, type: string, object: Record<string, unknown>, at: number) =>
    ins("StripeWebhookEvent", { id, eventId: `evt_${id}`, eventType: type, payload: JSON.stringify({ type, data: { object } }), processedAt: at, status: "DONE" });
  evt("w1", "product.created", { id: "prod_old", name: "Maintenance Site", active: true }, now - 30 * DAY);
  evt("w2", "price.created", { id: "price_old", product: "prod_old", unit_amount: 65000, recurring: { interval: "year" } }, now - 30 * DAY + 1);
  evt("w3", "product.updated", { id: "prod_old", name: "Maintenance Site", active: false }, now - DAY);
  evt("w4", "product.updated", { id: "prod_maint", name: "Maintenance", active: true }, now - DAY);
  ins("PromoCode", { id: "promo_1", code: "BIENVENUE", kind: "PERCENT", value: 1000, serviceIds: JSON.stringify(["svc_maint", "svc_gone"]) });
  ins("ServicePackItem", { id: "item1", packId: "svc_pack", serviceId: "svc_site", quantity: 1, position: 0 });
  const client = ins("Client", { id: "cli_1", type: "B2B", displayName: CLIENT.company, firstName: CLIENT.first, lastName: CLIENT.last, companyName: CLIENT.company, addressLine1: null, postalCode: null, city: null });
  ins("Client", { id: "cli_2", type: "ASSOCIATION", displayName: "Amicale Laïque", addressLine1: CLIENT.street, postalCode: "29600", city: "Morlaix" });
  ins("Subscription", { id: "sub_ended", clientId: client, serviceId: "svc_maint", label: "Maintenance", amountCents: 2900, billingDay: 1, startDate: now - 90 * DAY, endDate: now - 20 * DAY, nextInvoiceAt: now + 10 * DAY, status: "ENDED", collectionMethod: "STRIPE", billingInterval: "MONTH" });
  ins("Subscription", { id: "sub_active", clientId: client, serviceId: "svc_maint", label: "Maintenance", amountCents: 2900, billingDay: 1, startDate: now - 10 * DAY, nextInvoiceAt: now + 20 * DAY, status: "ACTIVE", billingInterval: "YEAR", commitmentMonths: null });
  ins("Invoice", { id: "inv_stripe_after_end", number: "F-2026-0042", documentType: "INVOICE", status: "ISSUED", clientId: client, subscriptionId: "sub_ended", stripeInvoiceId: "in_test_1", totalCents: 2900, createdAt: now - 2 * DAY, dueDate: now - DAY, quoteSignerName: `${CLIENT.first} ${CLIENT.last}` });
  ins("Invoice", { id: "quote_full", number: "D-2026-0007", documentType: "QUOTE", status: "ISSUED", quoteStatus: "ACCEPTED", clientId: client, totalCents: 100000 });
  ins("Invoice", { id: "inv_full", number: "F-2026-0043", documentType: "INVOICE", status: "PAID", clientId: client, quoteId: "quote_full", totalCents: 100000 });
  ins("PaymentMilestone", { id: "ms_open", quoteId: "quote_full", position: 2, label: "Solde", percentBps: 7000, amountCents: 70000, triggerText: "x", status: "PENDING" });
  ins("EmailOutbox", { id: "mail_failed", status: "FAILED", payload: "", lastError: `550 mailbox ${CLIENT.email} unavailable (${CLIENT.first} ${CLIENT.last})` });
  db.close();

  fs.writeFileSync(path.join(logDir, "worker.err"), [
    `[worker] outbox error Error: 550 rejected for ${CLIENT.email} from ${CLIENT.ip}`,
    `[worker] maintenance : étape relances en échec client ${CLIENT.first} ${CLIENT.last} tel ${CLIENT.phone}`,
    `[worker] stripe catalog sync error Invalid API Key provided: ${SECRETS.stripeKey}`,
    `virement refusé IBAN ${SECRETS.iban} adresse ${CLIENT.street} 29600 Morlaix, siret ${SECRETS.siret}`,
  ].join("\n"));
  fs.writeFileSync(path.join(logDir, "app.log"), [
    JSON.stringify({ level: 30, msg: "request completed", reqId: "req-1" }),
    JSON.stringify({ level: 50, msg: `signature refused for ${CLIENT.company}`, req: { remoteAddress: CLIENT.ipv6, headers: { authorization: `Bearer ${SECRETS.github}` } } }),
  ].join("\n"));
}, 120000);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("audit : masquage des journaux", () => {
  it("masque e-mails, IP v4 et v6, IBAN, téléphones, jetons, SIRET et adresses", () => {
    const lines = [
      `contact ${CLIENT.email} depuis ${CLIENT.ip} et ${CLIENT.ipv6}`,
      `IBAN ${SECRETS.iban} ou ${SECRETS.ibanCompact}`,
      `tel ${SECRETS.ownerPhone}, ${CLIENT.phone}, 0612345678, 06.12.34.56.78`,
      `Authorization: Bearer ${SECRETS.github} key ${SECRETS.stripeKey} ${SECRETS.stripeWebhook}`,
      `password=${SECRETS.smtpPass}&token=abc123def`,
      `siret ${SECRETS.siret} au ${CLIENT.street}, 29600 Morlaix`,
      "jeton public aB3dE5fG7hJ9kL1mN3pQ5r",
    ];
    const out = lines.map((l) => lib.maskText(l)).join("\n");
    for (const v of [...Object.values(SECRETS), CLIENT.email, CLIENT.ip, CLIENT.ipv6, CLIENT.phone, CLIENT.street, "0612345678", "06.12.34.56.78", "abc123def", "aB3dE5fG7hJ9kL1mN3pQ5r", "29600"]) {
      expect(out, v).not.toContain(v);
    }
    expect(out).toContain("[email]");
    expect(out).toContain("[ip]");
    expect(out).toContain("[iban]");
    expect(out).toContain("[téléphone]");
  });

  it("laisse intacts numéros de documents, identifiants internes, heures, dates et commits", () => {
    const keep = "F-2026-0043 D-2026-0007 A-2026-0001 cmv5tq14f000izwaocxe2cg1g 10:20:30 2026-10-28T16:40:42.574Z 196884820582fcfbdb70b23ba9357c33adf82a9b 17700";
    expect(lib.maskText(keep)).toBe(keep);
  });

  it("masque les noms connus des clients, mot par mot, sans tenir compte de la casse", () => {
    const mask = lib.nameMasker(lib.nameTokens([CLIENT.first, CLIENT.last, CLIENT.company]));
    const out = lib.maskFree(`échec pour ${CLIENT.first.toUpperCase()} ${CLIENT.last} (${CLIENT.company}) : relance`, mask);
    expect(out).not.toMatch(/gwena|kerbrat|boulangerie/i);
    expect(out).toContain("[nom]");
    expect(out).toContain("relance");
  });
});

describe("audit : réglages et .env", () => {
  it("n'affiche aucun secret ni coordonnée : seulement « défini » ou « absent »", () => {
    const row = {
      id: "s", smtpPassEncrypted: SECRETS.smtpPass, smtpPassHint: SECRETS.hint, stripeSecretKeyEncrypted: SECRETS.stripeKey, stripeWebhookSecretEncrypted: SECRETS.stripeWebhook,
      githubTokenEncrypted: SECRETS.github, bankIban: SECRETS.iban, bankBic: SECRETS.bic, email: SECRETS.ownerEmail, phone: SECRETS.ownerPhone, siret: SECRETS.siret,
      smtpUser: SECRETS.ownerEmail, obligationReminderEmail: SECRETS.ownerEmail, futureApiKeyColumn: "clé-future-123", futureTextColumn: "texte inconnu", revolutMerchantApiKeyEncrypted: null,
      invoiceNumberTemplate: "F-{year}-{counter}", cgvVersion: "2026-11-04", moduleStripeEnabled: 1, smtpPort: 465, githubTokenExpiresAt: 1790000000000, stripeWebhookSecretHint: "",
    };
    const types: Record<string, string> = { moduleStripeEnabled: "BOOLEAN", smtpPort: "INTEGER", githubTokenExpiresAt: "DATETIME", futureApiKeyColumn: "TEXT" };
    const out = lib.safeSettings(row, types);
    const json = JSON.stringify(out);
    for (const v of [...Object.values(SECRETS), "clé-future-123", "texte inconnu"]) expect(json).not.toContain(v);
    expect(out.smtpPassEncrypted).toBe("défini");
    expect(out.revolutMerchantApiKeyEncrypted).toBe("absent");
    expect(out.stripeWebhookSecretHint).toBe("absent");
    expect(out.githubTokenExpiresAt).toBe("défini");
    expect(out.futureTextColumn).toBe("défini");
    expect(out.invoiceNumberTemplate).toBe("F-{year}-{counter}");
    expect(out.cgvVersion).toBe("2026-11-04");
    expect(out.moduleStripeEnabled).toBe(true);
    expect(out.smtpPort).toBe(465);
  });

  it(".env : noms des variables seulement, jamais une valeur", () => {
    const env = `SMTP_PASS="${SECRETS.smtpPass}"\nENCRYPTION_KEY=${"a".repeat(64)}\nSMTP_HOST=smtp.example.org # commentaire\nEMPTY=\n`;
    const out = lib.envPresence(env, "SMTP_PASS=\nIMAP_PASS=\n");
    const json = JSON.stringify(out);
    expect(json).not.toContain(SECRETS.smtpPass);
    expect(json).not.toContain("a".repeat(16));
    expect(json).not.toContain("smtp.example.org");
    expect(out).toEqual({ EMPTY: "absent", ENCRYPTION_KEY: "défini", IMAP_PASS: "absent", SMTP_HOST: "défini", SMTP_PASS: "défini" });
  });
});

describe("audit : base en lecture seule", () => {
  it("toute écriture échoue", () => {
    const db = lib.openReadOnly(dbPath);
    expect(() => db.exec("INSERT INTO LegalClause (id, title, body, updatedAt) VALUES ('w', 't', 'b', 0)")).toThrow(/readonly|read-only|query_only/i);
    expect(() => db.exec("DELETE FROM Client")).toThrow();
    expect(() => db.exec("CREATE TABLE pirate (a)")).toThrow();
    expect(() => db.exec("PRAGMA query_only = OFF; DELETE FROM Client")).toThrow();
    db.close();
  });

  it("un rapport ne modifie pas le fichier de la base", () => {
    const before = sha(dbPath);
    expect(runReport(["--json"]).status).toBe(0);
    expect(sha(dbPath)).toBe(before);
  });
});

describe("audit : rapport complet", () => {
  it("JSON : aucun secret, aucun nom, e-mail, téléphone, IP ou adresse de client", () => {
    const run = runReport(["--json"]);
    expect(run.status, run.stderr).toBe(0);
    for (const v of ALL_FORBIDDEN) expect(run.stdout, v).not.toContain(v);
    expect(run.stdout).not.toMatch(/kerbrat|gwena/i);
  });

  it("texte : même garantie", () => {
    const run = runReport(["--text"]);
    expect(run.status, run.stderr).toBe(0);
    for (const v of ALL_FORBIDDEN) expect(run.stdout, v).not.toContain(v);
    expect(run.stdout).toContain("Rapport d'audit Kouzia ERP");
  });

  it("contrôles : comptes et anomalies identifiés par identifiant ou numéro de document", () => {
    const r = JSON.parse(runReport(["--json"]).stdout);
    expect(r.migrations.manquantes).toEqual([ids.lastMigration]);
    expect(r.cgv).toEqual({ publiees: true, version: "2026-11-04", url: "https://kouzia.com/cgv" });
    expect(r.reglages.valeurs.smtpPassEncrypted).toBe("défini");
    expect(r.clauses_legales[0]).toMatchObject({ kind: "VAT", required: true, active: true, body: "TVA non applicable, art. 293 B du CGI" });
    const maint = r.catalogue.prestations.find((s: { id: string }) => s.id === "svc_maint");
    expect(maint).toMatchObject({ intervalle: "MONTH", rachat: { id: "svc_site", nom: "Site vitrine" }, stripe: "test" });
    expect(r.catalogue.prestations.find((s: { id: string }) => s.id === "svc_pack")).toMatchObject({ pack: true, prix_annuel_cents: 150000 });
    expect(r.catalogue.supprimees).toEqual([
      { etat: "supprimée", id: "svc_gone", nom: null, cite_par: ["code promo BIENVENUE"] },
      expect.objectContaining({ etat: "supprimée", id: null, nom: "Maintenance Site", produit_stripe: "archivé", prix_cents: 65000, intervalle: "YEAR" }),
    ]);
    expect(runReport(["--text"]).stdout).toContain("Maintenance Site | supprimée | 650,00 €");
    expect(r.catalogue.contenu_des_packs).toEqual([expect.objectContaining({ pack_id: "svc_pack", prestation_id: "svc_site", quantite: 1 })]);
    expect(r.comptes.clients_par_type).toEqual({ ASSOCIATION: 1, B2B: 1 });
    expect(r.comptes.abonnements_par_engagement).toEqual({ "sans engagement": 2 });
    expect(r.controles.abonnements_actifs_sans_engagement.map((x: { id: string }) => x.id)).toEqual(["sub_active"]);
    expect(r.controles.abonnements_termines_avec_facture_stripe.map((x: { numero: string }) => x.numero)).toEqual(["F-2026-0042"]);
    expect(r.controles.jalons_ouverts_sur_devis_deja_factures).toEqual([expect.objectContaining({ jalon_id: "ms_open", devis: "D-2026-0007" })]);
    expect(r.controles.factures_emises_sans_adresse_client.map((x: { numero: string }) => x.numero).sort()).toEqual(["F-2026-0042", "F-2026-0043"]);
    expect(r.retards.factures_echues.map((x: { numero: string }) => x.numero)).toEqual(["F-2026-0042"]);
    expect(r.echecs.emails_en_echec).toHaveLength(1);
    expect(r.echecs.emails_en_echec[0].erreur).toContain("[email]");
    expect(r.echecs.emails_en_echec[0].erreur).toContain("[nom]");
    expect(r.journaux.fichiers["worker.err"]).toHaveLength(4);
    expect(r.journaux.fichiers["app.log"]).toHaveLength(1);
    expect(r.masquage.noms_connus_masques).toBeGreaterThan(0);
  });
});

// Commande forcée de la clé SSH : seul le format se choisit, tout le reste est refusé avant sudo.
const BASH = process.platform === "win32" && fs.existsSync("C:/Program Files/Git/bin/bash.exe") ? "C:/Program Files/Git/bin/bash.exe" : "bash";
describe("audit : commande forcée (--via-ssh)", () => {
  function viaSsh(original: string) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "kouzia-audit-bin-"));
    fs.writeFileSync(path.join(bin, "sudo"), '#!/bin/sh\necho "SUDO $*"\n', { mode: 0o755 });
    const run = spawnSync(BASH, [path.join(ROOT, "scripts/alpine/audit.sh").split(path.sep).join("/"), "report", "--via-ssh"], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SSH_ORIGINAL_COMMAND: original, SSH_CONNECTION: "198.51.100.7 50000 192.0.2.20 22", KOUZIA_APP_DIR: "/opt/kouziacrm" },
      encoding: "utf8",
    });
    fs.rmSync(bin, { recursive: true, force: true });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  }

  it("report, report --json : passe à sudo la seule commande permise", () => {
    expect(viaSsh("report").out).toContain("SUDO -n /opt/kouziacrm/scripts/alpine/audit.sh run text");
    expect(viaSsh("").out).toContain("run text");
    expect(viaSsh("report --json").out).toContain("SUDO -n /opt/kouziacrm/scripts/alpine/audit.sh run json");
  });

  it("toute autre commande est refusée sans appeler sudo", () => {
    for (const cmd of ["cat /etc/passwd", "report; sh", "report --json --db /etc/shadow", "run json", "sh"]) {
      const r = viaSsh(cmd);
      expect(r.status, cmd).toBe(2);
      expect(r.out).toContain("Commande refusée");
      expect(r.out).not.toContain("SUDO");
    }
  });
});
