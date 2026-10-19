import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { OfflineError } from "../network";
import { offlineRule, OFFLINE_RULES, sanitizeInvoice, sanitizeSettings } from "../offline/rules";
import { SETTINGS_READ_KEYS } from "../offline/rules-erp";
import { copiedAt, copyDateFor, formatCopyDate, resetServedForTests } from "../offline/served";
import {
  OFFLINE_DB,
  OFFLINE_STORES,
  readCopy,
  readUser,
  resetOfflineStoreForTests,
  saveCopy,
  saveUser,
  seal,
  unseal,
} from "../offline/store";

const ORIGIN = "https://erp.kouzia.test";
const latin1 = (bytes: ArrayBuffer) => new TextDecoder("latin1").decode(bytes);

/** Navigateur minimal : origine, contexte sécurisé, balise de configuration du hors ligne. */
function browserAt(origin: string, configured: string | null = ORIGIN, pathname = "/clients") {
  vi.stubGlobal("window", {
    isSecureContext: true,
    location: { origin, pathname },
    dispatchEvent: () => true,
  });
  vi.stubGlobal("document", {
    querySelector: () => (configured === null ? null : { content: configured }),
  });
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(OFFLINE_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Enregistrements bruts du magasin « copies », tels que le navigateur les garde. */
function rawRecords(): Promise<{ stores: string[]; values: unknown[] }> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(OFFLINE_DB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const stores = Array.from(db.objectStoreNames);
      const req = db.transaction("copies").objectStore("copies").getAll();
      req.onsuccess = () => {
        db.close();
        resolve({ stores, values: req.result });
      };
      req.onerror = () => reject(req.error);
    };
  });
}

async function eventually<T>(read: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("délai dépassé");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  await resetOfflineStoreForTests();
  resetServedForTests();
  await deleteDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chiffrement de la copie (AES-GCM 256)", () => {
  it("aller-retour, IV de 12 octets différent à chaque enregistrement, rien en clair", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const value = { displayName: "Client Témoin", email: "temoin@example.test" };
    const a = await seal(value, key, "/api/clients/c1");
    const b = await seal(value, key, "/api/clients/c1");
    expect(a.iv).toHaveLength(12);
    expect(a.iv.join()).not.toBe(b.iv.join());
    expect(latin1(a.data)).not.toContain("temoin@example.test");
    expect(await unseal(a, key, "/api/clients/c1")).toEqual(value);
  });

  it("valeur déplacée sous une autre clé d'enregistrement : refusée (données authentifiées)", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const sealed = await seal({ x: 1 }, key, "/api/clients/c1");
    await expect(unseal(sealed, key, "/api/clients/c2")).rejects.toThrow();
  });

  it("base IndexedDB : magasins « cle » et « copies » seulement, clé non extractible, valeurs illisibles en clair", async () => {
    await saveCopy("/api/clients/c1", { displayName: "Client Témoin", phone: "0600000000" });
    await saveUser({ id: "u1", email: "admin@example.test", name: "Admin" });
    expect(await readCopy("/api/clients/c1")).toMatchObject({ data: { displayName: "Client Témoin", phone: "0600000000" } });
    expect(await readUser()).toEqual({ id: "u1", email: "admin@example.test", name: "Admin" });

    const { stores, values } = await rawRecords();
    expect(stores.sort()).toEqual([...OFFLINE_STORES].sort());
    for (const value of values) {
      expect(Object.keys(value as object).sort()).toEqual(["data", "iv"]);
      const bytes = latin1((value as { data: ArrayBuffer }).data);
      expect(bytes).not.toMatch(/Client Témoin|0600000000|admin@example\.test|displayName/);
    }

    const key = await new Promise<CryptoKey>((resolve) => {
      const open = indexedDB.open(OFFLINE_DB);
      open.onsuccess = () => {
        const req = open.result.transaction("cle").objectStore("cle").get("principale");
        req.onsuccess = () => {
          open.result.close();
          resolve(req.result as CryptoKey);
        };
      };
    });
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
});

describe("liste fermée des lectures copiées", () => {
  it("fiche client : besoins et Précisions gardés, champs de chaque besoin limités à la liste", () => {
    const sanitize = offlineRule("/api/clients/cmabc123")!.sanitize;
    const copy = sanitize({
      id: "cmabc123",
      needsDetails: "5 pages",
      needs: [{ id: "1", label: "ancien", done: false }],
      serviceNeeds: [{ serviceId: "s1", name: "Site vitrine", active: true, doneAt: null, createdAt: "2026-10-19", secret: "x" }],
    }) as Record<string, unknown>;
    expect(copy.needsDetails).toBe("5 pages");
    expect(copy.needs).toBeUndefined();
    expect(copy.serviceNeeds).toEqual([{ serviceId: "s1", name: "Site vitrine", active: true, doneAt: null, createdAt: "2026-10-19" }]);
  });

  it("copiées : clients, fiche client (bloc-notes, notes de rendez-vous, projets), prestations, devis, factures, réglages des devis", () => {
    for (const path of [
      "/api/clients",
      "/api/clients?hasCorrespondence=true",
      "/api/clients/cmabc123",
      "/api/clients/cmabc123/notepad",
      "/api/clients/cmabc123/notes",
      "/api/clients/cmabc123/projects",
      "/api/services",
      "/api/services?active=1",
      "/api/invoices?type=QUOTE",
      "/api/invoices?type=INVOICE",
      "/api/invoices?clientId=cmabc123&pageSize=100",
      "/api/invoices?type=QUOTE&clientId=cmabc123&pageSize=100",
      "/api/invoices?clientId=cmabc123",
      "/api/invoices?type=QUOTE&clientId=cmabc123",
      "/api/invoices/summary?type=QUOTE",
      "/api/invoices/summary?type=INVOICE",
      "/api/invoices?type=INVOICE&market=cmq1",
      "/api/invoices/cminv1",
      "/api/settings",
      // Reste de l'ERP (décision du 19/10/2026) : pilotage, comptabilité, abonnements, messagerie, réglages en lecture.
      "/api/invoices",
      "/api/invoices?type=INVOICE&clientId=cmabc123",
      "/api/services?subscription=1",
      "/api/services?active=1&subscription=1",
      "/api/services/cms1/pack-lines",
      "/api/clients/cmabc123/renewals",
      "/api/clients/cmabc123/emails",
      "/api/clients/cmabc123/contacts",
      "/api/subscriptions",
      "/api/subscriptions/revisions-to-attach",
      "/api/quotes/cmq1/market",
      "/api/dashboard/overview?scope=month",
      "/api/dashboard",
      "/api/emails/inbox-summary",
      "/api/payments",
      "/api/receipts?year=2026",
      "/api/receipts?year=2026&quarter=3",
      "/api/receipts?year=2026&month=10",
      "/api/obligations",
      "/api/urssaf/declarations",
      "/api/owner-pay",
      "/api/stripe/flux",
      "/api/stripe/flux?month=2026-10",
      "/api/notifications/feed",
      "/api/emails/sync-status",
      "/api/emails/folders",
      "/api/emails/messages?folderId=cmf1&skip=0&take=50",
      "/api/emails/cmt1",
      "/api/emails/messages/cmm1/body?allowRemoteImages=true",
      "/api/checklist",
      "/api/legal-clauses",
      "/api/numbering/preview",
      "/api/google/calendar/status",
    ]) {
      expect(offlineRule(path), path).not.toBeNull();
    }
    expect(OFFLINE_RULES).toHaveLength(37);
  });

  it("bloc-notes : texte, version et dates seulement", () => {
    const rule = offlineRule("/api/clients/cmabc123/notepad")!;
    expect(rule.name).toBe("bloc-notes");
    expect(rule.sanitize({ text: "Rappeler", version: 3, updatedAt: "2026-10-19T08:00:00.000Z", conflictAt: null, conflict: true, clientId: "cmabc123", secret: "x" })).toEqual({
      text: "Rappeler",
      version: 3,
      updatedAt: "2026-10-19T08:00:00.000Z",
      conflictAt: null,
    });
    expect(offlineRule("/api/clients/cmabc123/notepad?x=1")).toBeNull();
  });

  it("synthèse des listes : des nombres seulement, rien d'autre ne passe", () => {
    const rule = offlineRule("/api/invoices/summary?type=INVOICE")!;
    expect(rule.name).toBe("synthèse des devis ou des factures");
    expect(offlineRule("/api/invoices/summary?type=ALL")).toBeNull();
    expect(
      rule.sanitize({ total: 3, byStatus: { ISSUED: 2, x: 1, PAID: "2" }, byKind: { factures: { ISSUED: 2 }, avoirs: {}, autre: 1 }, overdue: 1, toReview: 0, secret: "non" }),
    ).toEqual({ total: 3, byStatus: { ISSUED: 2 }, byKind: { factures: { ISSUED: 2 }, avoirs: {} }, overdue: 1, toReview: 0 });
  });

  it("solde d'une facture et montants de la synthèse : des nombres seulement", () => {
    const list = offlineRule("/api/invoices?type=INVOICE")!;
    const [row] = list.sanitize([
      { id: "f1", number: "F-1", totalCents: 100_000, balance: { creditedCents: 30_000, netCents: 70_000, refundedCents: 0, cashInCents: 0, dueCents: 70_000, secret: "x", note: "texte" } },
    ]) as Array<{ balance: unknown }>;
    expect(row!.balance).toEqual({ creditedCents: 30_000, netCents: 70_000, refundedCents: 0, cashInCents: 0, dueCents: 70_000 });
    const summary = offlineRule("/api/invoices/summary?type=INVOICE")!.sanitize({
      total: 1,
      byStatus: {},
      overdue: 0,
      toReview: 0,
      amounts: { toCollectCents: 70_000, cashInCents: 0, invoicedNetCents: 70_000, openCount: 1, paidCount: 0, fuite: "non" },
    }) as { amounts: unknown };
    expect(summary.amounts).toEqual({ toCollectCents: 70_000, cashInCents: 0, invoicedNetCents: 70_000, openCount: 1, paidCount: 0 });
  });

  it("jamais copiées : authentification, secrets, banque, pièces jointes, PDF, preuves, codes et jetons, module Site", () => {
    for (const path of [
      "/api/auth/me",
      "/api/auth/2fa/status",
      "/api/auth/2fa/recovery-codes",
      "/api/push/subscriptions",
      "/api/push/config",
      "/api/settings/smtp",
      "/api/settings/stripe",
      "/api/settings/imap",
      "/api/settings/revolut",
      "/api/withdrawals/beneficiaries",
      "/api/bank/transactions",
      "/api/banque",
      "/api/stripe/payouts",
      "/api/stripe/payouts/preview",
      "/api/receipts/pdf?year=2026",
      "/api/receipts/csv?year=2026",
      "/api/inbox/threads",
      "/api/emails/threads/t1",
      "/api/emails/attachments/a1",
      "/api/emails/messages?folderId=cmf1&q=dupont&skip=0&take=50",
      "/api/emails/messages?folderId=cmf1&skip=50&take=50",
      "/api/settings/identity/logo?v=3",
      "/api/obligations/cmo1/attachment",
      "/api/site/reviews",
      "/api/notifications/feed?since=2026-10-19T08%3A00%3A00.000Z",
      "/api/invoices/cminv1/pdf",
      "/api/quotes/cmq1/acceptances",
      "/api/quotes/cmq1/acceptances/a1/pdf",
      "/api/clients/cmabc123/portal/codes",
      "/api/onboarding/invitations",
      "/api/public/onboarding/jeton",
      "/api/invoices/search?q=dupont",
      "/api/clients?q=dupont",
      "/api/invoices?type=ALL",
    ]) {
      expect(offlineRule(path), path).toBeNull();
    }
  });

  it("projets de la fiche client : liste blanche de champs, champ inconnu exclu", () => {
    const [project] = OFFLINE_RULES.find((r) => r.name === "projets du client")!.sanitize([
      {
        id: "p1",
        name: "Site vitrine",
        progress: 40,
        status: "ACTIVE",
        steps: [{ label: "Maquette", status: "done", date: "2026-10-01", secretStep: "x" }],
        links: [{ label: "Préproduction", url: "https://pre.example.test", token: "abc" }],
        checklist: [{ label: "Logo reçu", done: true, note: null }],
        deposit2: { locked: false, missingStep: true, milestoneRef: "x" },
        internalSecret: "jamais copié",
      },
    ]) as Array<Record<string, unknown>>;
    expect(project).toMatchObject({ id: "p1", name: "Site vitrine", progress: 40, deposit2: { locked: false, missingStep: true } });
    expect(JSON.stringify(project)).not.toMatch(/internalSecret|secretStep|token|milestoneRef/);
  });

  it("réglages en lecture : identité et paramètres, aucun secret ni indice, ni banque, ni serveur de messagerie", () => {
    const settings = sanitizeSettings({
      legalName: "EI Kouzia",
      vatMention: "TVA non applicable, art. 293 B du CGI",
      paymentChoiceDefault: true,
      split3MinTotalCents: 150000,
      stripeSecretKeyHint: "sk_live_x",
      stripeWebhookSecretHint: "whsec_x",
      smtpHost: "smtp.example.test",
      smtpUser: "contact@example.test",
      smtpPassHint: "abcd",
      imapPassHint: "abcd",
      imapUser: "contact@example.test",
      revolutApiKeyHint: "x",
      bankIban: "FR7600000000000000000000000",
      bankBic: "REVOFRP2",
      siret: "00000000000000",
      emailSignatureHtml: "<p>x</p>",
      bankName: "Banque Exemple",
      bankAccountHolder: "EI Kouzia",
      googleReviewUrl: "https://g.page/exemple",
      googleCalendarConnectedEmail: "agenda@example.test",
      githubTokenHint: "ghp_x",
      depositPercentQuoteBps: 3000,
      split3FirstBps: 4000,
      brandLogoPath: "/data/logo.png",
      secrets: { stripeSecretKey: { set: true, hint: "abcd" } },
    });
    expect(settings).toMatchObject({ legalName: "EI Kouzia", siret: "00000000000000", googleReviewUrl: "https://g.page/exemple", depositPercentQuoteBps: 3000, split3FirstBps: 4000 });
    expect(Object.keys(settings!).every((k) => (SETTINGS_READ_KEYS as readonly string[]).includes(k) || k === "secrets" || /^(depositPercent\w*Bps|split3\w*)$/.test(k))).toBe(true);
    // Secrets : seulement « configuré ou non », jamais la valeur ni son indice.
    expect(settings!.secrets).toEqual({ stripeSecretKey: { set: true, hint: null } });
    expect(JSON.stringify(settings)).not.toMatch(/sk_live|whsec|smtp\.|contact@|revolut|FR76|REVOFRP2|Banque Exemple|agenda@|ghp_|logo\.png|abcd/i);
  });

  it("devis et factures : sans paiements, banque, liens de paiement, PDF, signataire ni identifiants Stripe ou Revolut", () => {
    const invoice = sanitizeInvoice({
      id: "i1",
      number: "F-2026-0001",
      totalCents: 120000,
      status: "PAID",
      client: { id: "c1", displayName: "Client Témoin", email: "temoin@example.test", stripeCustomerId: "cus_x" },
      lines: [{ id: "l1", description: "Site", quantity: 1, unitPriceCents: 120000, lineTotalCents: 120000 }],
      payments: [{ id: "p1", amountCents: 120000, method: "CARD" }],
      bankTransactions: [{ id: "b1", counterpartyName: "TEMOIN", reference: "VIR" }],
      checkoutUrl: "https://pay.example.test/x",
      stripeActionUrl: "https://stripe.example.test/x",
      stripeInvoiceId: "in_x",
      revolutOrderId: "rev_x",
      pdfPath: "data/pdf/F-2026-0001.pdf",
      pdfSha256: "abc",
      quoteSignerName: "Client Témoin",
      quoteAcceptanceAudits: [{ ip: "203.0.113.1" }],
      milestones: [{ id: "m1", label: "Acompte", amountCents: 36000, checkoutUrl: "https://pay.example.test/m", revolutOrderId: "rev_m", manualReference: "VIR" }],
    });
    expect(invoice).toMatchObject({ id: "i1", number: "F-2026-0001", totalCents: 120000, client: { email: "temoin@example.test" } });
    expect(invoice!.lines).toHaveLength(1);
    const text = JSON.stringify(invoice);
    for (const banned of ["payments", "bankTransactions", "checkoutUrl", "stripe", "revolut", "pdfPath", "pdfSha256", "quoteSignerName", "Audits", "manualReference", "cus_x", "203.0.113.1"]) {
      expect(text, banned).not.toContain(banned);
    }
  });
});

describe("api() : réseau d'abord, copie chiffrée ensuite", () => {
  it("en ligne : réponse du serveur, copie filtrée enregistrée", async () => {
    browserAt(ORIGIN);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ id: "c1", displayName: "Client Témoin", lastExchange: { subject: "Devis" } }])));
    const rows = await api<Array<{ id: string }>>("/api/clients");
    expect(rows).toHaveLength(1);
    expect(copiedAt(rows)).toBeNull();
    const copy = await eventually(() => readCopy<Array<Record<string, unknown>>>("/api/clients"));
    expect(copy.data).toEqual([{ id: "c1", displayName: "Client Témoin" }]);
  });

  it("hors ligne : copie servie, horodatée, rattachée à l'écran", async () => {
    browserAt(ORIGIN, ORIGIN, "/clients/c1");
    const savedAt = new Date(2026, 9, 17, 14, 5).getTime();
    await saveCopy("/api/clients/c1", { id: "c1", displayName: "Client Témoin" }, savedAt);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const client = await api<{ displayName: string }>("/api/clients/c1");
    expect(client.displayName).toBe("Client Témoin");
    expect(copiedAt(client)).toBe(savedAt);
    expect(copyDateFor("/clients/c1")).toBe(savedAt);
    expect(copyDateFor("/clients")).toBeNull();
  });

  it("serveur injoignable derrière le tunnel (502) : copie servie", async () => {
    browserAt(ORIGIN, ORIGIN, "/services");
    await saveCopy("/api/services", [{ id: "s1", name: "Site vitrine" }], 1000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Bad Gateway" }, 502)));
    expect(await api("/api/services")).toEqual([{ id: "s1", name: "Site vitrine" }]);
  });

  it("module Site hors ligne : pas de copie ; réglages d'appoint servis sans mention de date", async () => {
    browserAt(ORIGIN, ORIGIN, "/site/avis");
    await saveCopy("/api/clients", [{ id: "c1" }], 1000);
    await saveCopy("/api/settings", { legalName: "EI Kouzia" }, 1000);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api("/api/clients")).rejects.toBeInstanceOf(OfflineError);
    const settings = await api<{ legalName: string }>("/api/settings");
    expect(settings.legalName).toBe("EI Kouzia");
    expect(copiedAt(settings)).toBe(1000);
    expect(copyDateFor("/site/avis")).toBeNull();
  });

  it("session refusée (401) : jamais la copie", async () => {
    browserAt(ORIGIN);
    await saveCopy("/api/clients", [{ id: "c1" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "Non authentifié" }, 401)));
    await expect(api("/api/clients")).rejects.toMatchObject({ status: 401 });
  });

  it("lecture hors liste ou sans copie : OfflineError", async () => {
    browserAt(ORIGIN);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api("/api/payments")).rejects.toBeInstanceOf(OfflineError);
    await expect(api("/api/clients/inconnu")).rejects.toBeInstanceOf(OfflineError);
  });

  it("autre origine (Tailscale, LAN, dev) ou origine non configurée : rien n'est copié", async () => {
    for (const [origin, configured] of [["https://erp.tailnet.test", ORIGIN], [ORIGIN, null]] as const) {
      await resetOfflineStoreForTests();
      await deleteDb();
      browserAt(origin, configured);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ id: "c1" }])));
      await api("/api/clients");
      await new Promise((r) => setTimeout(r, 50));
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      await expect(api("/api/clients")).rejects.toBeInstanceOf(OfflineError);
    }
  });
});

describe("horodatage", () => {
  it("« Données du JJ/MM à HH h MM », en heure locale", () => {
    expect(formatCopyDate(new Date(2026, 9, 17, 9, 5).getTime())).toBe("Données du 17/10 à 09 h 05");
    expect(formatCopyDate(new Date(2026, 0, 3, 23, 59).getTime())).toBe("Données du 03/01 à 23 h 59");
  });
});
