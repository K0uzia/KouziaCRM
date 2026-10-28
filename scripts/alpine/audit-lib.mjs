// Rapport d'audit en lecture seule de l'ERP (kouziactl audit report, décision d'Alexandre du 28/10/2026).
// Sans dépendance (node:sqlite, Node 22.13 ou plus) : tourne sous le compte du service, jamais sous root.
// Ce qu'il ne montre jamais : données personnelles des clients (noms, e-mails, adresses, téléphones, IBAN, IP) et
// secrets (clés, jetons, mots de passe, champs chiffrés). Garanties :
//   1. base ouverte en lecture seule (readOnly + PRAGMA query_only) : aucune écriture possible ;
//   2. requêtes écrites à la main : comptes, identifiants internes et numéros de documents seulement ;
//   3. réglages : liste blanche (texte) et motif de secret (tout type) ; le reste n'est que « défini » ou « absent » ;
//   4. .env : noms des variables seulement, chaque valeur oubliée dès la lecture de sa ligne ;
//   5. dernier filet : toute chaîne de la sortie passe par maskText (e-mails, IP, IBAN, téléphones, jetons...),
//      et les journaux en plus par le masquage des noms connus des clients (lus en base, jamais affichés).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const REPORT_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// Masquage

const MASKS = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, "[clé]"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "[jeton]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{6,}/g, "[clé-stripe]"],
  [/\bwhsec_[A-Za-z0-9]{6,}/g, "[secret-webhook]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, "[jeton-github]"],
  [/\b(?:cus|pm|seti|pi|src|ba|card|acct|ch|in|sub|py|evt)_[A-Za-z0-9]{8,}/g, "[id-stripe]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[jwt]"],
  // clé=valeur ou clé: valeur (journaux, URL) : la valeur seule est masquée.
  [
    /\b((?:password|passwd|passphrase|pass|pwd|secret|token|jeton|api[_-]?key|apikey|authorization|cookie|access[_-]?code|accessCode|code|key|cle|clé|iban|bic|siret|siren|phone|telephone|téléphone|tel|email|mail|to|from|ip)\b"?\s*[=:]\s*"?)(?!\[)[^\s"'&,;}]+/gi,
    "$1[masqué]",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, "[iban]"],
  // IPv6 : au moins une lettre hexadécimale ou « :: » (une heure 10:20:30 n'est pas touchée).
  [/(?<![\w:])(?=[0-9A-Fa-f:]*[A-Fa-f])(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}(?![\w:])/g, "[ip]"],
  [/(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![\w:])|::ffff:/g, "[ip]"],
  [/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "[ip]"],
  [/(?:(?:\+|\b00)33[\s.-]?\(?0?\)?[\s.-]?[1-9]|\b0[1-9])(?:[\s.-]?\d{2}){4}\b/g, "[téléphone]"],
  [/\+\d{1,3}(?:[\s.-]?\d){7,12}\b/g, "[téléphone]"],
  // Jetons opaques : hexadécimal long, ou mélange majuscules, minuscules et chiffres (un cuid ou un commit n'y entre pas).
  [/\b[0-9A-Fa-f]{48,}\b/g, "[jeton]"],
  [/(?<![\w-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}(?![\w-])/g, "[jeton]"],
  [/(?<![\w+/])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{24,}={0,2}(?![\w+/])/g, "[jeton]"],
  // SIRET, SIREN, numéros de carte ou de compte : 9 chiffres et plus.
  [/\b\d(?:[ ]?\d){8,18}\b/g, "[numéro]"],
  [
    /\b\d{1,4}(?:\s?(?:bis|ter|b))?,?\s+(?:rue|avenue|av\.|bd|boulevard|chemin|impasse|place|allée|allee|route|quai|cours|lieu-dit|hameau|square|résidence|residence|voie|passage|cité|cite|zone|za|zi|lotissement)\b[^,;"\n\]]{0,60}/gi,
    "[adresse]",
  ],
  [/\b\d{5}(?=\s+\p{Lu})/gu, "[cp]"],
];

/** Masque les données personnelles et secrets reconnaissables dans un texte libre. */
export function maskText(text) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  for (const [re, by] of MASKS) out = out.replace(re, by);
  return out;
}

const NAME_STOP = new Set([
  "des", "les", "aux", "pour", "avec", "the", "and", "sas", "sasu", "sarl", "eurl", "sci", "cie", "ets", "scop",
  "test", "client", "null", "undefined",
]);

/** Mots à masquer tirés des noms des clients (valeurs entières et mots de 3 lettres et plus). */
export function nameTokens(values) {
  const set = new Set();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const full = v.trim();
    if (full.length >= 3) set.add(full.toLowerCase());
    for (const w of full.split(/[\s,.;:'’"()\[\]/&+_-]+/u)) {
      if (w.length >= 3 && !NAME_STOP.has(w.toLowerCase()) && !/^\d+$/.test(w)) set.add(w.toLowerCase());
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Masqueur des noms connus (insensible à la casse, mots entiers). */
export function nameMasker(tokens) {
  if (!tokens.length) return (s) => s;
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 400) {
    chunks.push(new RegExp(`(?<![\\p{L}\\p{N}])(?:${tokens.slice(i, i + 400).map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu"));
  }
  return (s) => {
    if (typeof s !== "string") return s;
    let out = s;
    for (const re of chunks) out = out.replace(re, "[nom]");
    return out;
  };
}

/** Texte libre venu des clients ou des services (journaux, erreurs) : motifs d'abord (un nom masqué dans une adresse
 * e-mail la rendrait méconnaissable et laisserait passer le domaine), puis noms connus. */
export function maskFree(text, maskNames = (s) => s) {
  if (typeof text !== "string") return text;
  return maskNames(maskText(text));
}

/** Dernier filet : chaque chaîne de l'objet passe par maskText (clés inchangées). */
export function guard(value) {
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map(guard);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = guard(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Réglages et .env

/** Nom de champ de secret : jamais de valeur, quel que soit son type. */
export const SECRET_FIELD_RE = /(encrypted|secret|pass(?!ive)|pwd|token|hint|api_?key|private|iban|bic|holder|refresh|webhook|credential|signature|otp|totp|recovery)/i;

/** Champs texte des réglages affichés en clair : textes et choix d'Alexandre, sans coordonnée ni secret. */
export const SAFE_TEXT_FIELDS = new Set([
  "country", "vatRegime", "vatMention", "urssafPeriodicity", "publicodesRegime", "invoicePrefix",
  "invoiceNumberTemplate", "quoteNumberTemplate", "creditNoteNumberTemplate", "paymentConditions", "latePenaltiesText",
  "earlyPaymentDiscountText", "legalMentions", "suspensionClause", "stripeKeyMode", "mediationClause", "smtpEncryption",
  "imapMailbox", "emailAutoApproveKinds", "legalForm", "brandPrimaryColor", "brandSecondaryColor", "pdfFooterText",
  "revolutMerchantMode", "split3Step2TriggerText", "cgvUrl", "cgvVersion", "withdrawalExpressRequestText",
  "website", "clientPortalUrl", "googleReviewUrl",
]);

/**
 * Vue sûre d'une ligne de réglages. types : { colonne: type SQLite déclaré }. Secret (motif) : « défini » ou « absent ».
 * Booléen, nombre, date : valeur. Texte ou JSON : valeur seulement s'il est dans la liste blanche, sinon « défini »
 * ou « absent ». Une colonne ajoutée plus tard est donc cachée tant qu'elle n'est pas ajoutée à la liste.
 */
export function safeSettings(row, types = {}) {
  const out = {};
  if (!row) return out;
  for (const [k, v] of Object.entries(row)) {
    const present = v !== null && v !== undefined && v !== "";
    const t = String(types[k] ?? "").toUpperCase();
    if (k === "id") continue;
    if (SECRET_FIELD_RE.test(k)) out[k] = present ? "défini" : "absent";
    else if (t === "BOOLEAN") out[k] = v === null ? null : Boolean(v);
    else if (t === "DATETIME") out[k] = v === null ? null : toIso(v);
    else if ((t === "INTEGER" || t === "REAL" || t === "DECIMAL") && (typeof v === "number" || typeof v === "bigint" || v === null)) out[k] = v === null ? null : Number(v);
    else if (SAFE_TEXT_FIELDS.has(k) && (typeof v === "string" || v === null)) out[k] = v;
    else out[k] = present ? "défini" : "absent";
  }
  return out;
}

/** Noms des variables d'un .env et présence d'une valeur ; aucune valeur n'est gardée. */
export function envPresence(envText, exampleText = "") {
  const read = (txt) => {
    const m = new Map();
    for (const raw of String(txt).split(/\r?\n/)) {
      const line = raw.trim();
      const hit = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!hit) continue;
      const v = hit[2].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
      m.set(hit[1], v !== "");
    }
    return m;
  };
  const env = read(envText);
  const out = {};
  for (const k of [...new Set([...env.keys(), ...read(exampleText).keys()])].sort()) out[k] = env.get(k) ? "défini" : "absent";
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Base

/** Ouvre la base en lecture seule : toute écriture échoue (SQLITE_READONLY), même une requête fautive. */
export function openReadOnly(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`Base introuvable : ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function toIso(v) {
  if (v === null || v === undefined) return null;
  const d = typeof v === "number" || typeof v === "bigint" ? new Date(Number(v)) : new Date(String(v).includes("T") || /^\d{4}-/.test(String(v)) ? String(v).replace(" ", "T") : Number(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Date Prisma sous SQLite : entier (ms) en général, texte si posée par un DEFAULT SQL.
const D = (c) => `(CASE typeof(${c}) WHEN 'integer' THEN ${c} WHEN 'real' THEN CAST(${c} AS INTEGER) WHEN 'text' THEN CAST(strftime('%s', ${c}) AS INTEGER) * 1000 ELSE NULL END)`;

function makeQ(db) {
  const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
  const one = (sql, ...p) => {
    const r = db.prepare(sql).get(...p);
    return r ? { ...r } : null;
  };
  const columns = (table) => db.prepare("SELECT name, type FROM pragma_table_info(?)").all(table).map((r) => ({ name: r.name, type: r.type }));
  const cache = new Map();
  // Colonne d'une base plus ancienne que le code : remplacée par NULL plutôt que de perdre la section.
  const col = (table, name, alias = "", fallback = "NULL") => {
    if (!cache.has(table)) cache.set(table, new Set(columns(table).map((c) => c.name)));
    return cache.get(table).has(name) ? `${alias}${name}` : fallback;
  };
  return { all, one, columns, col };
}

/** Section protégée : une table ou une colonne absente (base plus ancienne) ne fait pas échouer le rapport. */
function section(fn) {
  try {
    return fn();
  } catch (err) {
    return { erreur: maskText(err instanceof Error ? err.message : String(err)) };
  }
}

const groupCount = (rows, key) => Object.fromEntries(rows.map((r) => [r[key] === null ? "(vide)" : String(r[key]), Number(r.n)]));

// ---------------------------------------------------------------------------------------------------------------
// Version, migrations, journaux

function readGitHead(appDir) {
  try {
    let gitDir = path.join(appDir, ".git");
    if (!fs.existsSync(gitDir)) return null;
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(appDir, m[1].trim());
    }
    let common = gitDir;
    const cd = path.join(gitDir, "commondir");
    if (fs.existsSync(cd)) common = path.resolve(gitDir, fs.readFileSync(cd, "utf8").trim());
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return { branche: null, commit: head };
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (!ref || ref.includes("..")) return null;
    for (const base of [gitDir, common]) {
      const f = path.join(base, ref);
      if (fs.existsSync(f)) return { branche: ref.replace(/^refs\/heads\//, ""), commit: fs.readFileSync(f, "utf8").trim().slice(0, 40) };
    }
    const packed = path.join(common, "packed-refs");
    if (fs.existsSync(packed)) {
      const line = fs.readFileSync(packed, "utf8").split(/\r?\n/).find((l) => l.endsWith(` ${ref}`));
      if (line) return { branche: ref.replace(/^refs\/heads\//, ""), commit: line.slice(0, 40) };
    }
    return { branche: ref.replace(/^refs\/heads\//, ""), commit: null };
  } catch {
    return null;
  }
}

function versionInfo(appDir) {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version ?? null;
  } catch {
    /* absent */
  }
  const git = readGitHead(appDir);
  return { version, commit: git?.commit ?? null, branche: git?.branche ?? null };
}

function migrations(q, appDir) {
  const dir = path.join(appDir, "prisma", "migrations");
  const expected = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "migration.sql"))).sort()
    : [];
  const rows = q.all("SELECT migration_name AS name, finished_at AS f, rolled_back_at AS r FROM _prisma_migrations");
  const applied = new Set(rows.filter((r) => r.f !== null && r.r === null).map((r) => r.name));
  const failed = rows.filter((r) => r.f === null && r.r === null).map((r) => r.name);
  return {
    attendues: expected.length,
    appliquees: applied.size,
    manquantes: expected.filter((m) => !applied.has(m)),
    inconnues: [...applied].filter((m) => !expected.includes(m)).sort(),
    en_echec: failed,
    derniere_appliquee: [...applied].sort().at(-1) ?? null,
    derniere_attendue: expected.at(-1) ?? null,
  };
}

function tailLines(file, maxBytes = 512 * 1024) {
  const st = fs.statSync(file);
  const size = Math.min(st.size, maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    const lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
    if (st.size > size) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

const ERROR_LINE_RE = /("level"\s*:\s*(?:50|60)\b|\berror\b|\berreur\b|échec|\bfailed\b|exception|\bfatal\b|unhandled|ECONN|ETIMEDOUT)/i;

/** Dernières lignes d'erreur des journaux, masquées. *.err : toutes les lignes ; *.log : lignes d'erreur seulement. */
export function errorLogs(logDir, n, maskNames) {
  const out = { dossier: logDir ?? null, fichiers: {}, lignes_echec_worker: null };
  if (!logDir || !fs.existsSync(logDir)) {
    out.note = "dossier des journaux introuvable (normal en développement)";
    return out;
  }
  for (const name of ["app.err", "worker.err", "app.log", "worker.log"]) {
    const f = path.join(logDir, name);
    if (!fs.existsSync(f)) continue;
    try {
      let lines = tailLines(f);
      if (name.endsWith(".log")) lines = lines.filter((l) => ERROR_LINE_RE.test(l));
      if (name === "worker.err" || name === "worker.log") {
        const fails = lines.filter((l) => /en échec|error|failed/i.test(l)).length;
        out.lignes_echec_worker = (out.lignes_echec_worker ?? 0) + fails;
      }
      out.fichiers[name] = lines.slice(-n).map((l) => maskFree(l.length > 500 ? `${l.slice(0, 500)}…` : l, maskNames));
    } catch (err) {
      out.fichiers[name] = [`illisible (${err?.code ?? "erreur"})`];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Rapport

const NAME_SOURCES = [
  ["Client", ["displayName", "firstName", "lastName", "companyName"]],
  ["ClientContact", ["firstName", "lastName"]],
  ["User", ["name"]],
  ["Invoice", ["quoteSignerName"]],
  ["ClientTestimonial", ["authorName"]],
  ["SiteReview", ["authorName"]],
];

function knownNames(q) {
  const values = [];
  for (const [table, cols] of NAME_SOURCES) {
    const have = new Set(q.columns(table).map((c) => c.name));
    for (const c of cols) {
      if (!have.has(c)) continue;
      for (const r of q.all(`SELECT DISTINCT "${c}" AS v FROM "${table}" WHERE "${c}" IS NOT NULL`)) values.push(r.v);
    }
  }
  return nameTokens(values);
}

const OPEN_MILESTONE = "('PENDING','DUE','OVERDUE')";

/**
 * Rapport complet. opts : { dbPath, appDir, logDir, lines, now }.
 * Ne renvoie que des comptes, des identifiants internes (cuid) et des numéros de documents (D-, F-, A-).
 */
export function buildReport(opts) {
  const now = opts.now ?? Date.now();
  const n = Math.max(1, Math.min(200, Number(opts.lines ?? 30)));
  const db = openReadOnly(opts.dbPath);
  const q = makeQ(db);
  try {
    let maskNames = (s) => s;
    const namesState = section(() => {
      const tokens = knownNames(q);
      maskNames = nameMasker(tokens);
      return { noms_connus_masques: tokens.length };
    });

    const report = {
      rapport: "kouzia-audit",
      format: REPORT_VERSION,
      genere_le: new Date(now).toISOString(),
      erp: versionInfo(opts.appDir),
      base: section(() => ({
        lecture_seule: true,
        taille_octets: fs.statSync(opts.dbPath).size,
        journal: q.one("PRAGMA journal_mode")?.journal_mode ?? null,
      })),
      migrations: section(() => migrations(q, opts.appDir)),
      reglages: section(() => {
        const types = Object.fromEntries(q.columns("CompanySettings").map((c) => [c.name, c.type]));
        const rows = q.all("SELECT * FROM CompanySettings");
        return { lignes: rows.length, valeurs: safeSettings(rows[0] ?? null, types) };
      }),
      env: section(() => {
        const envFile = path.join(opts.appDir, ".env");
        const example = path.join(opts.appDir, ".env.example");
        let envText = "";
        let lisible = true;
        try {
          envText = fs.readFileSync(envFile, "utf8");
        } catch {
          lisible = false;
        }
        const ex = fs.existsSync(example) ? fs.readFileSync(example, "utf8") : "";
        const vars = envPresence(envText, ex);
        envText = "";
        return { fichier_lisible: lisible, variables: vars };
      }),
      cgv: section(() => {
        const r = q.one("SELECT cgvPublished AS p, cgvVersion AS v, cgvUrl AS u FROM CompanySettings LIMIT 1");
        return r ? { publiees: Boolean(r.p), version: r.v, url: r.u } : null;
      }),
      clauses_legales: section(() =>
        q.all("SELECT * FROM LegalClause ORDER BY position, createdAt").map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          active: Boolean(r.active),
          required: Boolean(r.required),
          audience: r.audience ?? null,
          position: r.position,
          supprimee: r.deletedAt !== undefined && r.deletedAt !== null,
          body: r.body,
        })),
      ),
      catalogue: section(() => {
        const services = q.all("SELECT * FROM Service ORDER BY name");
        const byId = new Map(services.map((s) => [s.id, s.name]));
        const items = section(() => q.all("SELECT packId, serviceId, quantity, position FROM ServicePackItem ORDER BY packId, position"));
        return {
          prestations: services.map((s) => ({
            id: s.id,
            nom: s.name,
            active: Boolean(s.active),
            categorie: s.category ?? null,
            pack: Boolean(s.isPack),
            abonnement: Boolean(s.isSubscription),
            intervalle: s.billingInterval ?? null,
            prix_cents: s.unitPriceCents,
            unite: s.unit,
            prix_annuel_cents: s.annualPriceCents ?? null,
            jour_facturation: s.defaultBillingDay ?? null,
            rachat: s.buyoutServiceId ? { id: s.buyoutServiceId, nom: byId.get(s.buyoutServiceId) ?? "(introuvable)" } : null,
            stripe: s.stripePriceId ? (s.stripeLivemode === 1 ? "live" : s.stripeLivemode === 0 ? "test" : "lié") : "non lié",
          })),
          contenu_des_packs: Array.isArray(items)
            ? items.map((i) => ({ pack: byId.get(i.packId) ?? i.packId, pack_id: i.packId, prestation: byId.get(i.serviceId) ?? i.serviceId, prestation_id: i.serviceId, quantite: i.quantity, position: i.position }))
            : items,
        };
      }),
      comptes: {
        clients_par_type: section(() => groupCount(q.all("SELECT type, COUNT(*) AS n FROM Client GROUP BY type"), "type")),
        clients_sans_adresse: section(() => Number(q.one("SELECT COUNT(*) AS n FROM Client WHERE COALESCE(TRIM(addressLine1),'') = '' OR COALESCE(TRIM(postalCode),'') = '' OR COALESCE(TRIM(city),'') = ''").n)),
        abonnements_par_statut: section(() => groupCount(q.all("SELECT status, COUNT(*) AS n FROM Subscription GROUP BY status"), "status")),
        abonnements_par_intervalle: section(() => groupCount(q.all("SELECT billingInterval, COUNT(*) AS n FROM Subscription GROUP BY billingInterval"), "billingInterval")),
        abonnements_par_encaissement: section(() => groupCount(q.all("SELECT collectionMethod, COUNT(*) AS n FROM Subscription GROUP BY collectionMethod"), "collectionMethod")),
        abonnements_par_engagement: section(() =>
          groupCount(q.all("SELECT CASE WHEN commitmentMonths IS NULL THEN 'sans engagement' ELSE commitmentMonths || ' mois' END AS k, COUNT(*) AS n FROM Subscription GROUP BY k"), "k"),
        ),
        devis_par_statut: section(() => groupCount(q.all("SELECT COALESCE(quoteStatus, status) AS k, COUNT(*) AS n FROM Invoice WHERE documentType = 'QUOTE' GROUP BY k"), "k")),
        factures_par_statut: section(() => groupCount(q.all("SELECT status, COUNT(*) AS n FROM Invoice WHERE documentType = 'INVOICE' GROUP BY status"), "status")),
        factures_par_nature: section(() => groupCount(q.all("SELECT invoiceType, COUNT(*) AS n FROM Invoice WHERE documentType = 'INVOICE' GROUP BY invoiceType"), "invoiceType")),
        avoirs_par_statut: section(() => groupCount(q.all("SELECT status, COUNT(*) AS n FROM Invoice WHERE documentType = 'CREDIT_NOTE' GROUP BY status"), "status")),
        jalons_par_statut: section(() => groupCount(q.all("SELECT status, COUNT(*) AS n FROM PaymentMilestone GROUP BY status"), "status")),
        file_emails_par_statut: section(() => groupCount(q.all("SELECT status, COUNT(*) AS n FROM EmailOutbox GROUP BY status"), "status")),
        obligations_par_statut: section(() => groupCount(q.all("SELECT status, COUNT(*) AS n FROM Obligation GROUP BY status"), "status")),
      },
      controles: {
        abonnements_actifs_sans_engagement: section(() =>
          q.all("SELECT id, billingInterval AS intervalle, collectionMethod AS encaissement FROM Subscription WHERE status = 'ACTIVE' AND commitmentMonths IS NULL ORDER BY createdAt"),
        ),
        factures_emises_sans_adresse_client: section(() =>
          q.all(
            `SELECT i.id, i.number AS numero, i.status AS statut,
               CASE WHEN ${q.col("Invoice", "clientSnapshotEncrypted", "i.")} IS NULL AND i.clientSnapshot IS NULL THEN 'document sans copie du client'
                    ELSE 'fiche client actuelle sans adresse complète' END AS motif
             FROM Invoice i JOIN Client c ON c.id = i.clientId
             WHERE i.documentType = 'INVOICE' AND i.status IN ('ISSUED','PAID')
               AND ((${q.col("Invoice", "clientSnapshotEncrypted", "i.")} IS NULL AND i.clientSnapshot IS NULL)
                 OR COALESCE(TRIM(c.addressLine1),'') = '' OR COALESCE(TRIM(c.postalCode),'') = '' OR COALESCE(TRIM(c.city),'') = '')
             ORDER BY i.number`,
          ),
        ),
        jalons_ouverts_sur_devis_deja_factures: section(() =>
          q.all(
            `WITH billed AS (
               SELECT COALESCE(quoteId, sourceQuoteId) AS qid, SUM(totalCents) AS cents FROM Invoice
               WHERE documentType = 'INVOICE' AND status IN ('ISSUED','PAID') AND COALESCE(quoteId, sourceQuoteId) IS NOT NULL
               GROUP BY qid)
             SELECT m.id AS jalon_id, m.position, m.status AS statut, q.number AS devis, q.totalCents AS devis_cents, b.cents AS facture_cents
             FROM PaymentMilestone m JOIN Invoice q ON q.id = m.quoteId JOIN billed b ON b.qid = q.id
             WHERE m.status IN ${OPEN_MILESTONE} AND q.totalCents > 0 AND b.cents >= q.totalCents
             ORDER BY q.number, m.position`,
          ),
        ),
        abonnements_termines_avec_facture_stripe: section(() =>
          q.all(
            `SELECT i.id, i.number AS numero, i.status AS statut, s.id AS abonnement_id,
               ${D("i.createdAt")} AS cree_ms, ${D("COALESCE(s.endDate, s.stripeStatusChangedAt)")} AS fin_ms
             FROM Invoice i JOIN Subscription s ON s.id = i.subscriptionId
             WHERE s.status = 'ENDED' AND i.stripeInvoiceId IS NOT NULL
               AND ${D("i.createdAt")} > COALESCE(${D("COALESCE(s.endDate, s.stripeStatusChangedAt)")}, ${D("s.updatedAt")})
             ORDER BY i.createdAt`,
          ).map((r) => ({ id: r.id, numero: r.numero, statut: r.statut, abonnement_id: r.abonnement_id, creee_le: toIso(r.cree_ms), fin_abonnement: toIso(r.fin_ms) })),
        ),
        abonnements_actifs_echeance_depassee: section(() =>
          q.all(`SELECT id, ${D("nextInvoiceAt")} AS ms, collectionMethod AS encaissement FROM Subscription WHERE status = 'ACTIVE' AND ${D("nextInvoiceAt")} < ? ORDER BY nextInvoiceAt`, now - 86400000)
            .map((r) => ({ id: r.id, encaissement: r.encaissement, prochaine_facture: toIso(r.ms) })),
        ),
      },
      retards: {
        factures_echues: section(() =>
          q.all(`SELECT id, number AS numero, totalCents AS montant_cents, ${D("dueDate")} AS ms FROM Invoice WHERE documentType = 'INVOICE' AND status = 'ISSUED' AND ${D("dueDate")} < ? ORDER BY dueDate`, now)
            .map((r) => ({ id: r.id, numero: r.numero, montant_cents: r.montant_cents, echeance: toIso(r.ms), jours: Math.floor((now - Number(r.ms)) / 86400000) })),
        ),
        jalons_echus: section(() =>
          q.all(`SELECT m.id, q.number AS devis, m.position, m.status AS statut, m.amountCents AS montant_cents, ${D("m.dueDate")} AS ms FROM PaymentMilestone m JOIN Invoice q ON q.id = m.quoteId WHERE m.status IN ${OPEN_MILESTONE} AND ${D("m.dueDate")} < ? ORDER BY m.dueDate`, now)
            .map((r) => ({ id: r.id, devis: r.devis, position: r.position, statut: r.statut, montant_cents: r.montant_cents, echeance: toIso(r.ms) })),
        ),
        devis_envoyes_expires: section(() =>
          q.all(`SELECT id, number AS numero, ${D("validUntil")} AS ms FROM Invoice WHERE documentType = 'QUOTE' AND quoteStatus = 'SENT' AND ${D("validUntil")} < ? ORDER BY validUntil`, now)
            .map((r) => ({ id: r.id, numero: r.numero, valable_jusqu_au: toIso(r.ms) })),
        ),
        obligations_en_retard: section(() =>
          q.all(`SELECT id, type, period AS periode, status AS statut, ${D("dueDate")} AS ms FROM Obligation WHERE status IN ('PENDING','LATE') AND ${D("dueDate")} < ? ORDER BY dueDate`, now)
            .map((r) => ({ id: r.id, type: r.type, periode: r.periode, statut: r.statut, echeance: toIso(r.ms) })),
        ),
      },
      echecs: {
        emails_en_echec: section(() =>
          q.all(`SELECT id, attempts AS tentatives, ${q.col("EmailOutbox", "reviewFamily")} AS famille, ${q.col("EmailOutbox", "documentId")} AS document_id, lastError AS erreur, ${D("updatedAt")} AS ms FROM EmailOutbox WHERE status = 'FAILED' ORDER BY updatedAt DESC LIMIT 20`)
            .map((r) => ({ id: r.id, tentatives: r.tentatives, famille: r.famille, document_id: r.document_id, le: toIso(r.ms), erreur: maskFree(r.erreur, maskNames) })),
        ),
        emails_bloques_en_envoi: section(() => Number(q.one(`SELECT COUNT(*) AS n FROM EmailOutbox WHERE status = 'SENDING' AND ${D("updatedAt")} < ?`, now - 15 * 60000).n)),
        emails_a_valider_depuis_24h: section(() => Number(q.one(`SELECT COUNT(*) AS n FROM EmailOutbox WHERE status = 'REVIEW' AND ${D("createdAt")} < ?`, now - 86400000).n)),
        webhooks_stripe_bloques: section(() => Number(q.one(`SELECT COUNT(*) AS n FROM StripeWebhookEvent WHERE ${q.col("StripeWebhookEvent", "status", "", "'DONE'")} = 'PROCESSING' AND ${D(`COALESCE(${q.col("StripeWebhookEvent", "claimedAt")}, processedAt)`)} < ?`, now - 15 * 60000).n)),
        synchro_mail: section(() => {
          const r = q.one(`SELECT connected, lastError, ${D("lastSyncAt")} AS ms FROM MailSyncStatus LIMIT 1`);
          return r ? { connectee: Boolean(r.connected), derniere_synchro: toIso(r.ms), erreur: maskFree(r.lastError, maskNames) } : null;
        }),
        synchro_banque_en_echec_7j: section(() => Number(q.one(`SELECT COUNT(*) AS n FROM BankSyncLog WHERE errorMessage IS NOT NULL AND ${D("startedAt")} > ?`, now - 7 * 86400000).n)),
      },
      journaux: errorLogs(opts.logDir, n, maskNames),
      masquage: namesState,
    };
    return guard(report);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Texte lisible

const eur = (c) => (c === null || c === undefined ? "-" : `${(Number(c) / 100).toFixed(2).replace(".", ",")} €`);

export function renderText(r) {
  const L = [];
  const h = (t) => L.push("", `== ${t} ==`);
  const kv = (obj, indent = "  ") => {
    if (!obj || typeof obj !== "object") return L.push(`${indent}${obj ?? "-"}`);
    if (obj.erreur) return L.push(`${indent}(section indisponible : ${obj.erreur})`);
    const entries = Object.entries(obj);
    if (!entries.length) return L.push(`${indent}(aucun)`);
    for (const [k, v] of entries) L.push(`${indent}${k} : ${v === null ? "-" : typeof v === "object" ? JSON.stringify(v) : v}`);
  };
  const list = (rows, fmt) => {
    if (!Array.isArray(rows)) return L.push(`  (section indisponible : ${rows?.erreur ?? "?"})`);
    if (!rows.length) return L.push("  aucun");
    for (const x of rows) L.push(`  - ${fmt(x)}`);
  };
  L.push(`Rapport d'audit Kouzia ERP (lecture seule), ${r.genere_le}`);
  h("ERP");
  kv(r.erp);
  kv(r.base);
  h("Migrations");
  kv(r.migrations);
  h("CGV");
  kv(r.cgv);
  h("Réglages (secrets : défini ou absent seulement)");
  if (r.reglages?.erreur) kv(r.reglages);
  else kv(r.reglages?.valeurs);
  h("Variables du .env (noms seulement)");
  if (r.env?.erreur) kv(r.env);
  else {
    L.push(`  fichier lisible : ${r.env?.fichier_lisible ? "oui" : "non"}`);
    kv(r.env?.variables);
  }
  h("Clauses légales");
  list(r.clauses_legales, (c) => `[${c.kind}] ${c.title} (active : ${c.active ? "oui" : "non"}, obligatoire : ${c.required ? "oui" : "non"}, public : ${c.audience ?? "-"}${c.supprimee ? ", supprimée" : ""}, id ${c.id})\n      ${String(c.body ?? "").replace(/\n/g, "\n      ")}`);
  h("Catalogue");
  if (r.catalogue?.erreur) kv(r.catalogue);
  else {
    list(r.catalogue?.prestations, (s) =>
      `${s.nom} | ${s.active ? "active" : "archivée"} | ${s.categorie ?? "Autres"}${s.pack ? " | pack" : ""}${s.abonnement ? " | abonnement" : ""} | ${eur(s.prix_cents)} / ${s.unite}${s.intervalle ? ` | ${s.intervalle}` : ""}${s.prix_annuel_cents !== null ? ` | annuel ${eur(s.prix_annuel_cents)}` : ""}${s.rachat ? ` | rachat : ${s.rachat.nom}` : ""} | Stripe ${s.stripe} | id ${s.id}`);
    L.push("  Contenu des packs :");
    list(r.catalogue?.contenu_des_packs, (i) => `${i.pack} : ${i.quantite} x ${i.prestation}`);
  }
  h("Comptes");
  for (const [k, v] of Object.entries(r.comptes ?? {})) L.push(`  ${k} : ${typeof v === "object" ? JSON.stringify(v) : v}`);
  h("Contrôles de cohérence");
  for (const [k, v] of Object.entries(r.controles ?? {})) {
    L.push(`  ${k} : ${Array.isArray(v) ? v.length : "?"}`);
    if (Array.isArray(v)) for (const x of v.slice(0, 50)) L.push(`    - ${Object.entries(x).map(([a, b]) => `${a}=${b ?? "-"}`).join(" ")}`);
    else if (v?.erreur) L.push(`    (indisponible : ${v.erreur})`);
  }
  h("Retards");
  for (const [k, v] of Object.entries(r.retards ?? {})) {
    L.push(`  ${k} : ${Array.isArray(v) ? v.length : "?"}`);
    if (Array.isArray(v)) for (const x of v.slice(0, 50)) L.push(`    - ${Object.entries(x).map(([a, b]) => `${a}=${b ?? "-"}`).join(" ")}`);
    else if (v?.erreur) L.push(`    (indisponible : ${v.erreur})`);
  }
  h("Échecs et files");
  for (const [k, v] of Object.entries(r.echecs ?? {})) {
    if (Array.isArray(v)) {
      L.push(`  ${k} : ${v.length}`);
      for (const x of v) L.push(`    - ${Object.entries(x).map(([a, b]) => `${a}=${b ?? "-"}`).join(" ")}`);
    } else L.push(`  ${k} : ${v && typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  h("Journaux (lignes d'erreur, masquées)");
  L.push(`  dossier : ${r.journaux?.dossier ?? "-"}${r.journaux?.note ? ` (${r.journaux.note})` : ""}`);
  if (r.journaux?.lignes_echec_worker !== null && r.journaux?.lignes_echec_worker !== undefined) L.push(`  lignes d'échec du worker (fin du journal) : ${r.journaux.lignes_echec_worker}`);
  for (const [f, lines] of Object.entries(r.journaux?.fichiers ?? {})) {
    L.push(`  -- ${f} (${lines.length})`);
    for (const l of lines) L.push(`    ${l}`);
  }
  L.push("", `Masquage : ${JSON.stringify(r.masquage)}`);
  return `${L.join("\n")}\n`;
}
