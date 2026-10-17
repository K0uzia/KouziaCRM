import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueue,
  getQueueSnapshot,
  isLocalClientId,
  loadQueue,
  localClientId,
  removeItem,
  replayQueue,
  resetQueueForTests,
  retryItem,
  submitCreation,
} from "../offline/queue";
import { OFFLINE_DB, resetOfflineStoreForTests } from "../offline/store";

const ORIGIN = "https://erp.kouzia.test";
const latin1 = (bytes: ArrayBuffer) => new TextDecoder("latin1").decode(bytes);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let online = false;

/** Navigateur minimal sur l'origine du hors ligne ; réseau coupé tant que online vaut false. */
function browser() {
  vi.stubGlobal("window", {
    isSecureContext: true,
    location: { origin: ORIGIN, pathname: "/clients" },
    dispatchEvent: () => true,
  });
  vi.stubGlobal("document", { querySelector: () => ({ content: ORIGIN }) });
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
}

type Sent = { method: string; path: string; body: Record<string, unknown> | null; cookieless: boolean };

/**
 * Serveur factice : création idempotente par clientRequestId, comme l'API. session=false : /api/auth/me répond
 * { user: null } et toute création 401. loseResponse : la création est faite, puis la réponse se perd.
 */
function fakeServer(opts: { session?: boolean; deletedClients?: string[]; knownEmails?: Record<string, string> } = {}) {
  const state = {
    session: opts.session ?? true,
    loseResponse: new Set<string>(),
    created: new Map<string, { id: string; kind: string; clientId?: string }>(),
    sent: [] as Sent[],
  };
  let n = 0;
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (!online) throw new TypeError("Failed to fetch");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    state.sent.push({ method, path: input, body, cookieless: !("headers" in (init ?? {})) || true });
    if (input === "/api/auth/me") return json({ user: state.session ? { id: "u1" } : null });
    if (!state.session) return json({ error: "Non authentifié" }, 401);
    const requestId = String(body?.clientRequestId ?? "");
    const already = state.created.get(requestId);
    const respond = (status: number, payload: unknown) => {
      if (state.loseResponse.delete(requestId)) throw new TypeError("Failed to fetch");
      return json(payload, status);
    };
    if (input === "/api/clients" && method === "POST") {
      if (already) return respond(200, { id: already.id, displayName: "Lou Martin", replayed: true });
      const knownId = opts.knownEmails?.[String(body?.email ?? "")];
      if (knownId) {
        return respond(409, { error: "Un client existe déjà", code: "client_exists", client: { id: knownId, displayName: "Lou Martin (existante)" } });
      }
      const id = `srv-client-${++n}`;
      state.created.set(requestId, { id, kind: "client" });
      return respond(201, { id, displayName: "Lou Martin" });
    }
    if (input === "/api/invoices" && method === "POST") {
      if (already) return respond(200, { id: already.id, offline: { replayed: true, conflicts: [] } });
      if (opts.deletedClients?.includes(String(body?.clientId))) return respond(404, { error: "Client introuvable", code: "client_not_found" });
      const id = `srv-quote-${++n}`;
      state.created.set(requestId, { id, kind: "quote", clientId: String(body?.clientId) });
      return respond(201, { id, offline: { replayed: false, conflicts: [] } });
    }
    const note = /^\/api\/clients\/([^/]+)\/notes$/.exec(input);
    if (note && method === "POST") {
      if (already) return respond(200, { id: already.id, replayed: true });
      if (opts.deletedClients?.includes(note[1]!)) return respond(404, { error: "Client introuvable", code: "client_not_found" });
      const id = `srv-note-${++n}`;
      state.created.set(requestId, { id, kind: "note", clientId: note[1] });
      return respond(201, { id });
    }
    return json({ error: "Introuvable" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(OFFLINE_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function rawQueue(): Promise<{ stores: string[]; values: Array<{ iv: Uint8Array; data: ArrayBuffer }> }> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(OFFLINE_DB);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction("file").objectStore("file").getAll();
      req.onsuccess = () => {
        const stores = Array.from(db.objectStoreNames);
        db.close();
        resolve({ stores, values: req.result });
      };
    };
  });
}

/** Un client, puis un devis et une note pour lui, préparés hors ligne. */
async function prepareClientQuoteNote() {
  const client = await enqueue({
    kind: "client",
    label: "Client Lou Martin",
    clientName: "Lou Martin",
    body: { type: "B2C", firstName: "Lou", lastName: "Martin", email: "lou@exemple.test", sendPortalAccess: false },
  });
  const quote = await enqueue({
    kind: "quote",
    label: "Devis pour Lou Martin",
    clientId: client.clientId,
    clientName: "Lou Martin",
    body: { documentType: "QUOTE", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 1200 }] },
  });
  const note = await enqueue({
    kind: "note",
    label: "Note pour Lou Martin",
    clientId: client.clientId,
    clientName: "Lou Martin",
    body: { body: "Rendez-vous : refonte du site." },
  });
  return { client, quote, note };
}

beforeEach(async () => {
  online = false;
  resetQueueForTests();
  await resetOfflineStoreForTests();
  await deleteDb();
  browser();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("file des créations hors ligne", () => {
  it("chaque élément : UUID et date de préparation, chiffré dans IndexedDB, sans cookie ni jeton", async () => {
    const { client, quote } = await prepareClientQuoteNote();
    expect(client.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(client.preparedAt)).not.toBeNaN();
    expect(isLocalClientId(quote.clientId)).toBe(true);
    expect(quote.clientId).toBe(localClientId(client.id));

    const { stores, values } = await rawQueue();
    expect(stores.sort()).toEqual(["cle", "copies", "file", "relire"]);
    expect(values).toHaveLength(3);
    for (const value of values) {
      expect(Object.keys(value).sort()).toEqual(["data", "iv"]);
      expect(value.iv).toHaveLength(12);
      expect(latin1(value.data)).not.toMatch(/Lou|Martin|exemple\.test|refonte|clientRequestId|label/);
    }
    // Relue depuis la base : mêmes éléments, aucun champ de session.
    resetQueueForTests();
    await loadQueue();
    const items = getQueueSnapshot().items;
    expect(items.map((i) => i.kind)).toEqual(["client", "quote", "note"]);
    expect(JSON.stringify(items)).not.toMatch(/cookie|token|session|jeton/i);
  });

  it("rejeu dans l'ordre des dépendances : le client d'abord, puis devis et note avec son vrai identifiant", async () => {
    await prepareClientQuoteNote();
    const server = fakeServer();
    online = true;
    expect(await replayQueue()).toBe("done");
    const posts = server.sent.filter((s) => s.method === "POST");
    expect(posts.map((p) => p.path)).toEqual(["/api/clients", "/api/invoices", "/api/clients/srv-client-1/notes"]);
    expect(posts[1]!.body).toMatchObject({ clientId: "srv-client-1", documentType: "QUOTE" });
    expect(posts.every((p) => typeof p.body?.clientRequestId === "string")).toBe(true);
    expect(posts[2]!.body).toMatchObject({ body: "Rendez-vous : refonte du site." });
    expect(typeof posts[2]!.body?.preparedAt).toBe("string");
    expect(server.created.size).toBe(3);
    expect(getQueueSnapshot().items).toHaveLength(0);
    resetQueueForTests();
    await loadQueue();
    expect(getQueueSnapshot().items).toHaveLength(0);
  });

  it("hors ligne : rien ne part, la file reste entière", async () => {
    await prepareClientQuoteNote();
    const server = fakeServer();
    expect(await replayQueue()).toBe("offline");
    expect(server.created.size).toBe(0);
    expect(getQueueSnapshot().items).toHaveLength(3);
  });

  it("réponse perdue puis nouvel envoi : chaque élément créé une seule fois", async () => {
    const { quote } = await prepareClientQuoteNote();
    const server = fakeServer();
    online = true;
    server.loseResponse.add(quote.id);
    expect(await replayQueue()).toBe("offline");
    expect(getQueueSnapshot().items.map((i) => i.kind)).toEqual(["quote", "note"]);
    expect(await replayQueue()).toBe("done");
    expect([...server.created.values()].map((c) => c.kind)).toEqual(["client", "quote", "note"]);
    expect(server.sent.filter((s) => s.path === "/api/invoices")).toHaveLength(2);
    expect(getQueueSnapshot().items).toHaveLength(0);
  });

  it("deux rejeux simultanés : un seul envoi par élément", async () => {
    await prepareClientQuoteNote();
    const server = fakeServer();
    online = true;
    const [a, b] = await Promise.all([replayQueue(), replayQueue()]);
    expect([a, b]).toEqual(["done", "done"]);
    expect(server.sent.filter((s) => s.method === "POST")).toHaveLength(3);
  });

  it("session expirée : rien n'est envoyé, la file reste, reconnexion demandée", async () => {
    await prepareClientQuoteNote();
    const server = fakeServer({ session: false });
    online = true;
    const onSessionExpired = vi.fn();
    expect(await replayQueue({ onSessionExpired })).toBe("session");
    expect(onSessionExpired).toHaveBeenCalledOnce();
    expect(server.sent.filter((s) => s.method === "POST")).toHaveLength(0);
    expect(getQueueSnapshot()).toMatchObject({ sessionExpired: true });
    expect(getQueueSnapshot().items).toHaveLength(3);
    // Reconnecté : tout part.
    server.session = true;
    expect(await replayQueue()).toBe("done");
    expect(getQueueSnapshot()).toMatchObject({ sessionExpired: false, items: [] });
  });

  it("client supprimé depuis la préparation : l'élément reste, « à revoir »", async () => {
    await enqueue({ kind: "quote", label: "Devis", clientId: "srv-supprime", clientName: "Ancien", body: { lines: [] } });
    fakeServer({ deletedClients: ["srv-supprime"] });
    online = true;
    expect(await replayQueue()).toBe("done");
    const [item] = getQueueSnapshot().items;
    expect(item).toMatchObject({ state: "review", message: "Client supprimé depuis la préparation." });
    // Nouvel essai : toujours à revoir, rien de créé.
    await retryItem(item!.id);
    expect(getQueueSnapshot().items[0]).toMatchObject({ state: "review" });
  });

  it("adresse déjà connue : pas de doublon, devis et note rattachés à la fiche existante et signalés", async () => {
    await prepareClientQuoteNote();
    const server = fakeServer({ knownEmails: { "lou@exemple.test": "srv-existant" } });
    online = true;
    expect(await replayQueue()).toBe("done");
    expect([...server.created.values()].map((c) => [c.kind, c.clientId])).toEqual([
      ["quote", "srv-existant"],
      ["note", "srv-existant"],
    ]);
    const [signal] = getQueueSnapshot().signals;
    expect(signal).toMatchObject({ kind: "client", to: "/clients/srv-existant" });
    expect(signal!.messages[0]).toMatch(/déjà connue.*2 éléments rattachés/);
  });

  it("client retiré de la file : ses devis et notes passent « à revoir », jamais envoyés", async () => {
    const { client } = await prepareClientQuoteNote();
    await removeItem(client.id);
    const server = fakeServer();
    online = true;
    await replayQueue();
    expect(server.sent.filter((s) => s.method === "POST")).toHaveLength(0);
    expect(getQueueSnapshot().items.map((i) => i.state)).toEqual(["review", "review"]);
  });

  it("formulaire en ligne : envoi direct avec un clientRequestId ; serveur injoignable : mis en file avec le même", async () => {
    const server = fakeServer();
    online = true;
    const direct = await submitCreation<{ id: string }>({ kind: "client", label: "Client", clientName: "Lou", body: { type: "B2C", lastName: "Lou" } });
    expect(direct).toMatchObject({ queued: false, data: { id: "srv-client-1" } });
    expect(getQueueSnapshot().items).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const queued = await submitCreation({ kind: "note", label: "Note", clientId: "srv-client-1", clientName: "Lou", body: { body: "x" } });
    expect(queued.queued).toBe(true);
    expect(getQueueSnapshot().items).toHaveLength(1);
    expect(server.created.size).toBe(1);
  });
});
