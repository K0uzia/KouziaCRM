import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/offline/config", () => ({ offlineEnabled: () => true, configuredOfflineOrigin: () => "http://localhost" }));

const { putCopyForTests, readCopy, resetOfflineStoreForTests, COPY_FORMAT } = await import("../offline/store");
const sync = await import("../offline/sync");

/** localStorage minimal (vitest tourne sous Node). */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  };
}

/** Serveur simulé : deux clients, un devis, une facture ; journal des lectures. */
let server: Record<string, unknown>;
let reads: string[];
function resetServer(updatedAt = "2026-10-01T00:00:00Z") {
  const client = (id: string) => ({ id, displayName: `Client ${id}`, type: "B2C", updatedAt });
  const doc = (id: string, documentType: string, clientId: string) => ({ id, documentType, clientId, number: id, totalCents: 1000, updatedAt });
  server = {
    "/api/clients": [client("c1"), client("c2")],
    "/api/invoices?type=QUOTE": [doc("q1", "QUOTE", "c1")],
    "/api/invoices?type=INVOICE": [doc("f1", "INVOICE", "c2")],
    "/api/invoices/summary?type=QUOTE": { counts: {} },
    "/api/invoices/summary?type=INVOICE": { counts: {} },
    "/api/services": [{ id: "s1", name: "Site" }],
    "/api/services?active=1": [{ id: "s1", name: "Site" }],
    "/api/settings": { legalName: "Exemple" },
    // Reste de l'ERP : réponses vides, chaque lecture existe.
    "/api/dashboard/overview?scope=month": {},
    "/api/dashboard/overview?scope=quarter": {},
    "/api/dashboard/overview?scope=year": {},
    "/api/dashboard": {},
    "/api/emails/inbox-summary": { messages: [] },
    "/api/notifications/feed": { items: [] },
    "/api/emails/sync-status": {},
    "/api/payments": [],
    "/api/invoices": [],
    [`/api/receipts?year=${new Date().getFullYear()}`]: { rows: [], totalCents: 0 },
    "/api/obligations": { items: [], history: [] },
    "/api/urssaf/declarations": [],
    "/api/owner-pay": { flows: [], withdrawals: [] },
    "/api/stripe/flux": { payouts: [] },
    "/api/subscriptions": [],
    "/api/services?subscription=1": [],
    "/api/services?active=1&subscription=1": [],
    "/api/subscriptions/revisions-to-attach": [],
    "/api/checklist": {},
    "/api/legal-clauses": [],
    "/api/numbering/preview": {},
    "/api/google/calendar/status": {},
    "/api/emails/folders": { folders: [{ id: "f1" }] },
    "/api/emails/messages?folderId=f1&skip=0&take=50": { messages: [{ threadId: "t1", receivedAt: new Date().toISOString() }] },
    "/api/emails/t1": { id: "t1", messages: [] },
    "/api/quotes/q1/market": { milestones: [] },
  };
  for (const id of ["c1", "c2"]) {
    server[`/api/clients/${id}`] = client(id);
    server[`/api/clients/${id}/notepad`] = { text: `Bloc-notes ${id}`, version: 1, updatedAt, conflictAt: null };
    server[`/api/clients/${id}/projects`] = [];
    server[`/api/clients/${id}/renewals`] = [];
    server[`/api/clients/${id}/emails`] = { items: [] };
    server[`/api/clients/${id}/contacts`] = [];
    server[`/api/invoices?type=INVOICE&clientId=${id}`] = [];
    server[`/api/invoices?clientId=${id}`] = [];
    server[`/api/invoices?type=QUOTE&clientId=${id}`] = [];
  }
  server["/api/invoices/q1"] = doc("q1", "QUOTE", "c1");
  server["/api/invoices/f1"] = doc("f1", "INVOICE", "c2");
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("navigator", { onLine: true });
  await resetOfflineStoreForTests();
  indexedDB.deleteDatabase("kouzia-hors-ligne");
  sync.resetOfflineCopyForTests();
  resetServer();
  reads = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url);
      reads.push(path);
      if (!(path in server)) return new Response(JSON.stringify({ error: "introuvable" }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(server[path]), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("copie automatique complète pour le hors ligne", () => {
  it("copie complète : chaque fiche, jamais visitée comprise, avec son bloc-notes, ses projets et pièces ; résumé enregistré", async () => {
    const summary = await sync.runOfflineCopy({ full: true, visible: true });
    expect(summary).toMatchObject({ clients: 2, quotes: 1, invoices: 1, services: 1, format: sync.SYNC_FORMAT, full: true });
    for (const path of ["/api/clients/c2", "/api/clients/c2/notepad", "/api/clients/c2/projects", "/api/invoices?clientId=c2", "/api/invoices/q1", "/api/invoices/f1", "/api/settings"]) {
      expect(await readCopy(path), path).not.toBeNull();
    }
    expect(summary!.sizeBytes).toBeGreaterThan(0);
    expect(sync.needsFullCopy()).toBe(false);
    expect(sync.copyContents(summary!)).toBe("2 clients, 1 devis, 1 facture, 1 prestation, 1 fil de messages");
  });

  it("mise à jour incrémentale : seule la fiche modifiée est relue, avec les listes de pièces de son client", async () => {
    await sync.runOfflineCopy({ full: true, visible: false });
    const later = new Date(Date.now() + 60_000).toISOString();
    (server["/api/clients"] as Array<{ id: string; updatedAt: string }>)[1]!.updatedAt = later;
    reads = [];
    await sync.runOfflineCopy({ full: false, visible: false });
    expect(reads).toContain("/api/clients/c2");
    expect(reads).not.toContain("/api/clients/c1");
    expect(reads).not.toContain("/api/invoices/q1");
  });

  it("bloc-notes modifié sans que la fiche change : seul le bloc-notes est relu", async () => {
    await sync.runOfflineCopy({ full: true, visible: false });
    const later = new Date(Date.now() + 60_000).toISOString();
    (server["/api/clients"] as Array<{ id: string; notepadUpdatedAt?: string }>)[0]!.notepadUpdatedAt = later;
    server["/api/clients/c1/notepad"] = { text: "Nouveau texte", version: 2, updatedAt: later, conflictAt: null };
    reads = [];
    await sync.runOfflineCopy({ full: false, visible: false });
    expect(reads).toContain("/api/clients/c1/notepad");
    expect(reads).not.toContain("/api/clients/c1");
    expect(reads).not.toContain("/api/clients/c2/notepad");
    expect((await readCopy("/api/clients/c1/notepad"))?.data).toMatchObject({ text: "Nouveau texte", version: 2 });
  });

  it("fiche disparue du serveur : sa copie et ce qui en dépend sont retirés", async () => {
    await sync.runOfflineCopy({ full: true, visible: false });
    server["/api/clients"] = (server["/api/clients"] as Array<{ id: string }>).filter((c) => c.id !== "c2");
    await sync.runOfflineCopy({ full: false, visible: false });
    expect(await readCopy("/api/clients/c2")).toBeNull();
    expect(await readCopy("/api/clients/c2/notepad")).toBeNull();
    expect(await readCopy("/api/clients/c1")).not.toBeNull();
  });

  it("annulation : la copie s'arrête, avec un message, et repartira au prochain passage en ligne", async () => {
    const run = sync.runOfflineCopy({ full: true, visible: true });
    sync.cancelOfflineCopy();
    expect(await run).toBeNull();
    expect(sync.copyState()).toMatchObject({ running: false, error: expect.stringContaining("annulée") });
    expect(sync.needsFullCopy()).toBe(true);
  });

  it("changement de format : copie complète relancée ; copie de format 1 (ou sans champ v) toujours lue", async () => {
    await sync.runOfflineCopy({ full: true, visible: false });
    localStorage.setItem("kouzia:hors-ligne:copie-complete", JSON.stringify({ ...sync.copyState().summary, format: sync.SYNC_FORMAT - 1 }));
    sync.resetOfflineCopyForTests();
    expect(sync.needsFullCopy()).toBe(true);
    await putCopyForTests("/api/clients/ancien", { savedAt: 1, data: { id: "ancien" } });
    expect((await readCopy<{ id: string }>("/api/clients/ancien"))?.data).toEqual({ id: "ancien" });
    expect(COPY_FORMAT).toBe(1);
  });

  it("message hors ligne précis : avancement pendant une copie, sinon copie au prochain passage en ligne", () => {
    expect(sync.missingCopyMessage("Cette fiche", { ...sync.copyState(), running: true, phase: "Clients", done: 32, total: 47 })).toBe(
      "Cette fiche n'est pas encore sur l'appareil (copie en cours, clients 32 sur 47).",
    );
    expect(sync.missingCopyMessage("Ce devis", sync.copyState(), false)).toBe("Ce devis n'est pas sur l'appareil : il sera copié au prochain passage en ligne.");
  });
});

describe("journal de diagnostic de la copie", () => {
  it("copie terminée avec une lecture refusée : refus compté par statut, éléments copiés, aucune donnée de client", async () => {
    const journal = await import("../offline/journal");
    journal.resetJournalForTests();
    delete server["/api/clients/c2/projects"];
    await sync.runOfflineCopy({ full: true, visible: false, trigger: "manuel" });
    const [entry] = journal.readJournal();
    expect(entry).toMatchObject({ trigger: "manuel", mode: "full", outcome: "terminée", refused: { "404": 1 } });
    expect(entry!.copied).toBeGreaterThan(10);
    expect(JSON.stringify(journal.readJournal())).not.toMatch(/\/api\/|c1|c2|Exemple/);
  });

  it("demandée à la main sans réseau : « non lancée », avec la raison ; automatique sans réseau : rien de noté", async () => {
    const journal = await import("../offline/journal");
    journal.resetJournalForTests();
    vi.stubGlobal("navigator", { onLine: false });
    await sync.runOfflineCopy({ full: false, visible: false });
    expect(journal.readJournal()).toHaveLength(0);
    await sync.runOfflineCopy({ full: true, visible: true, trigger: "manuel" });
    expect(journal.readJournal()).toMatchObject([{ outcome: "non lancée", detail: "Pas de réseau.", copied: 0 }]);
  });

  it("refus lus pour Alexandre : session expirée, limite de débit, erreur serveur", async () => {
    const journal = await import("../offline/journal");
    expect(journal.refusalHint({ "401": 3 })).toMatch(/Session expirée/);
    expect(journal.refusalHint({ "429": 1 })).toMatch(/limite de débit/);
    expect(journal.refusalHint({ "502": 1 })).toMatch(/serveur a répondu en erreur/);
    expect(journal.refusalHint({ "404": 1 })).toBeNull();
    expect(journal.refusedText({ "401": 2, "404": 1 })).toBe("3 refus (401 : 2, 404 : 1)");
    expect(journal.refusedText({})).toBe("");
  });
});
