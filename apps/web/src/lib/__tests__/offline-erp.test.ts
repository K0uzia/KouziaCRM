import { describe, expect, it } from "vitest";
import { offlineRule } from "../offline/rules";
import { copyPathOf, htmlToText } from "../offline/rules-erp";

const sanitize = (path: string, data: unknown) => offlineRule(path)!.sanitize(data);
const old = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
const fresh = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();

describe("copie hors ligne du reste de l'ERP : listes blanches", () => {
  it("abonnements : sans jeton de l'espace client ni identifiant Stripe", () => {
    const [sub] = sanitize("/api/subscriptions", [
      { id: "s1", label: "Maintenance", amountCents: 35000, status: "ACTIVE", publicToken: "jeton-secret", stripeSubscriptionId: "sub_123", stripeStatus: "active", client: { id: "c1", displayName: "Lou", emailEncrypted: "x" }, service: { id: "v1", name: "Maintenance", stripePriceId: "price_1" } },
    ]) as Array<Record<string, unknown>>;
    expect(sub).toMatchObject({ id: "s1", amountCents: 35000, stripeStatus: "active", client: { id: "c1", displayName: "Lou" }, service: { id: "v1", name: "Maintenance" } });
    expect(JSON.stringify(sub)).not.toMatch(/jeton-secret|sub_123|price_1|emailEncrypted/);
  });

  it("marché d'un devis : jalons sans lien de paiement, commande Revolut ni référence de virement", () => {
    const market = sanitize("/api/quotes/q1/market", {
      quote: { id: "q1", number: "D-1", totalCents: 100, client: { id: "c1", displayName: "Lou" } },
      milestones: [{ id: "m1", label: "Acompte", amountCents: 30, checkoutUrl: "https://pay.example.test/x", revolutOrderId: "ord_1", manualReference: "VIR-42", invoice: { id: "i1", number: "F-1", pdfPath: "/x.pdf" } }],
      balance: { balanceDueCents: 70, pendingMilestones: [{ id: "m2", checkoutUrl: "https://pay.example.test/y" }] },
    });
    expect(market).toMatchObject({ quote: { id: "q1", client: { displayName: "Lou" } }, milestones: [{ id: "m1", amountCents: 30, invoice: { id: "i1", number: "F-1" } }] });
    expect(JSON.stringify(market)).not.toMatch(/pay\.example|ord_1|VIR-42|pdf/);
  });

  it("tableau de bord : pièces à relancer sans lien de paiement ni PDF, courrier des 90 derniers jours ; « t » ignoré", () => {
    expect(copyPathOf("/api/dashboard/overview?scope=month&t=17")).toBe("/api/dashboard/overview?scope=month");
    expect(copyPathOf("/api/dashboard/overview?scope=month")).toBe("/api/dashboard/overview?scope=month");
    const d = sanitize("/api/dashboard/overview?scope=month", {
      company: { legalName: "EI Kouzia", bankIban: "FR76" },
      pendingCount: 2,
      reminders: [{ id: "i1", number: "F-1", totalCents: 100, checkoutUrl: "https://pay.example.test", pdfPath: "/a.pdf", quoteSignerName: "Lou", client: { id: "c1", displayName: "Lou" } }],
      mail: { unreadCount: 1, messages: [{ id: "e1", subject: "Récent", receivedAt: fresh }, { id: "e2", subject: "Ancien", receivedAt: old }] },
      mailSync: { imapConfigured: true, lastSyncAt: fresh, lastError: "AUTH imap.example.test" },
      secretInconnu: "non",
    }) as Record<string, unknown>;
    expect(d).toMatchObject({ company: { legalName: "EI Kouzia" }, pendingCount: 2, reminders: [{ id: "i1", number: "F-1", client: { displayName: "Lou" } }] });
    expect((d.mail as { messages: unknown[] }).messages).toHaveLength(1);
    expect(JSON.stringify(d)).not.toMatch(/FR76|pay\.example|a\.pdf|quoteSignerName|imap\.example|secretInconnu|Ancien/);
  });

  it("encaissements : sans identifiant de paiement Stripe ni reçu PDF", () => {
    const [p] = sanitize("/api/payments", [
      { id: "p1", amountCents: 500, paidAt: fresh, method: "TRANSFER", reference: "VIR-1", stripePaymentIntentId: "pi_1", receiptPdfPath: "/r.pdf", receiptPdfSha256: "abc", invoice: { id: "i1", number: "F-1", client: { displayName: "Lou" } } },
    ]) as Array<Record<string, unknown>>;
    expect(p).toMatchObject({ id: "p1", amountCents: 500, reference: "VIR-1", invoice: { number: "F-1", client: { displayName: "Lou" } } });
    expect(JSON.stringify(p)).not.toMatch(/pi_1|r\.pdf|abc/);
  });

  it("retraits : sans l'e-mail de l'auteur ; flux Stripe : montants et dates", () => {
    const o = sanitize("/api/owner-pay", { availableCents: 1, flows: [], withdrawals: [{ id: "w1", amountCents: 2, date: fresh, createdByEmail: "admin@example.test" }] });
    expect(JSON.stringify(o)).not.toMatch(/admin@/);
    const f = sanitize("/api/stripe/flux?month=2026-10", { months: ["2026-10"], payouts: [{ id: "po1", amountCents: 9, payments: [{ id: "p1", amountCents: 9, invoice: { number: "F-1", client: { displayName: "Lou", email: "lou@example.test" } } }] }] });
    expect(f).toMatchObject({ payouts: [{ id: "po1", payments: [{ invoice: { number: "F-1", client: { displayName: "Lou" } } }] }] });
    expect(JSON.stringify(f)).not.toMatch(/lou@/);
  });

  it("messagerie : texte des 90 derniers jours, HTML réduit au texte, ni en-têtes bruts, ni pièces jointes, ni preuve de signature", () => {
    const thread = sanitize("/api/emails/t1", {
      id: "t1",
      subject: "Devis",
      acceptanceAudits: [{ id: "a1", signerName: "Lou", ipAddress: "1.2.3.4" }],
      messages: [
        { id: "m1", receivedAt: fresh, subject: "Devis", bodyText: "", bodyHtml: "<p>Bonjour&nbsp;Lou,</p><script>x()</script><img src=https://tracker.example.test/p.gif>Merci", rawHeaders: "Received: from smtp", imapUid: 42, attachments: [{ id: "f1", filename: "contrat.pdf" }] },
        { id: "m2", receivedAt: old, subject: "Ancien", bodyText: "trop vieux" },
      ],
    }) as { messages: Array<Record<string, unknown>>; acceptanceAudits: unknown[] };
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ id: "m1", bodyText: "Bonjour Lou,\nMerci", bodyHtml: null, bodyFetched: true, attachments: [] });
    expect(thread.acceptanceAudits).toEqual([]);
    expect(JSON.stringify(thread)).not.toMatch(/script|tracker|Received:|imapUid|contrat\.pdf|1\.2\.3\.4|trop vieux/);
    const list = sanitize("/api/emails/messages?folderId=f1&skip=0&take=50", { total: 2, messages: [{ id: "m1", receivedAt: fresh, subject: "A" }, { id: "m2", receivedAt: old, subject: "B" }] }) as { messages: unknown[] };
    expect(list.messages).toHaveLength(1);
    // Total ramené aux messages gardés : pas de page suivante demandée hors ligne.
    expect((list as unknown as { total: number }).total).toBe(1);
    expect(sanitize("/api/emails/folders", { folders: [{ id: "f1", displayName: "Boîte", imapPath: "INBOX" }], syncStatus: { connected: true, lastError: "AUTH imap.example.test" } })).toEqual({
      folders: [{ id: "f1", displayName: "Boîte" }],
      virtualFolders: [],
      syncStatus: { connected: true },
    });
  });

  it("texte d'un e-mail HTML : balises retirées, entités décodées, paragraphes gardés", () => {
    expect(htmlToText("<style>p{}</style><div>Ligne 1</div><div>A &amp; B &lt;ok&gt;</div><br>Fin")).toBe("Ligne 1\nA & B <ok>\n\nFin");
  });

  it("agenda Google : sans l'adresse connectée ; réglages : jamais d'adresse push ni de 2FA", () => {
    expect(sanitize("/api/google/calendar/status", { configured: true, connected: true, enabled: true, email: "agenda@example.test" })).toEqual({ configured: true, connected: true, enabled: true });
    expect(offlineRule("/api/push/subscriptions")).toBeNull();
    expect(offlineRule("/api/auth/2fa/status")).toBeNull();
  });
});

describe("404 d'une lecture copiée", () => {
  it("une liste en 404 n'emporte pas les fiches copiées ; une fiche en 404 emporte ses sous-ressources", async () => {
    const { dependsOn } = await import("../api");
    const list = dependsOn("/api/invoices");
    expect(list("/api/invoices")).toBe(true);
    expect(list("/api/invoices/i1")).toBe(false);
    expect(dependsOn("/api/payments")("/api/payments/p1")).toBe(false);
    const client = dependsOn("/api/clients/c1");
    expect(client("/api/clients/c1/notepad")).toBe(true);
    expect(client("/api/invoices?clientId=c1")).toBe(true);
    expect(client("/api/clients/c2")).toBe(false);
  });
});
