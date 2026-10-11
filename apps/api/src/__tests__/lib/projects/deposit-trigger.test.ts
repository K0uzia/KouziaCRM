import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { acceptQuoteByClient, issueQuote } from "@/lib/invoices/transitions.js";
import { listNotifications } from "@/lib/notifications/feed.js";
import {
  listClientProjects,
  projectInputSchema,
  ProjectError,
  updateClientProject,
  type ProjectInput,
} from "@/lib/projects/service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
});

afterEach(async () => {
  await resetDb();
});

/** Devis accepté (formule au choix), projet lié au devis comme project_from_quote. */
async function projectFromQuote(plan: "TWO" | "THREE") {
  const client = await createClient({ displayName: "Restaurant Le Port" });
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: 119_000,
      totalCents: 119_000,
      paymentPlanOffer: "CHOICE",
      lines: { create: [{ position: 1, description: "Site restaurant", quantity: 1, unitPriceCents: 119_000, lineTotalCents: 119_000 }] },
    },
  });
  await issueQuote(quote.id);
  await acceptQuoteByClient(quote.id, "Marie Martin", { paymentPlan: plan });
  const project = await prisma.clientProject.create({
    data: { clientId: client.id, name: "Site restaurant", quoteId: quote.id },
  });
  return { quoteId: quote.id, projectId: project.id, clientId: client.id };
}

type StepIn = { label: string; status: "done" | "current" | "todo"; triggersDeposit2?: boolean };
const input = (steps: StepIn[]): ProjectInput =>
  projectInputSchema.parse({ name: "Site restaurant", progress: 50, steps });

const deposit2 = (quoteId: string) =>
  prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 2 } });

describe("2e acompte déclenché par une étape de projet", () => {
  it("étape cochée faite : jalon exigible et notification, sans facture émise", async () => {
    const { quoteId, projectId, clientId } = await projectFromQuote("THREE");
    const since = new Date(Date.now() - 1000);

    await updateClientProject(projectId, input([{ label: "Maquette validée", status: "current", triggersDeposit2: true }]));
    expect((await deposit2(quoteId)).status).toBe(MilestoneStatus.PENDING);

    await updateClientProject(projectId, input([{ label: "Maquette validée", status: "done", triggersDeposit2: true }]));
    const m = await deposit2(quoteId);
    expect(m.status).toBe(MilestoneStatus.DUE);
    expect(m.triggerStepLabel).toBe("Maquette validée");
    expect(m.invoiceId).toBeNull();
    expect(await prisma.invoice.count({ where: { quoteId, documentType: InvoiceDocumentType.INVOICE } })).toBe(0);

    const notes = (await listNotifications(since)).filter((n) => n.kind === "deposit_due");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.href).toBe(`/quotes/${quoteId}`);

    // Étape repassée « en cours » : le jalon reste exigible.
    await updateClientProject(projectId, input([{ label: "Maquette validée", status: "current", triggersDeposit2: true }]));
    expect((await deposit2(quoteId)).status).toBe(MilestoneStatus.DUE);

    const [fiche] = await listClientProjects(clientId);
    expect(fiche!.deposit2).toEqual({ locked: true, missingStep: false });
  });

  it("une fois exigible, l'étape déclencheuse ne peut plus changer", async () => {
    const { projectId } = await projectFromQuote("THREE");
    await updateClientProject(projectId, input([{ label: "Maquette validée", status: "done", triggersDeposit2: true }]));
    await expect(
      updateClientProject(projectId, input([{ label: "Mise en ligne", status: "todo", triggersDeposit2: true }])),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("une seule étape cochable", () => {
    const parsed = projectInputSchema.safeParse({
      name: "P",
      progress: 0,
      steps: [
        { label: "A", status: "todo", triggersDeposit2: true },
        { label: "B", status: "todo", triggersDeposit2: true },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("devis accepté en 2 fois : case refusée", async () => {
    const { projectId } = await projectFromQuote("TWO");
    await expect(
      updateClientProject(projectId, input([{ label: "Maquette", status: "todo", triggersDeposit2: true }])),
    ).rejects.toBeInstanceOf(ProjectError);
  });

  it("garde-fou : devis en 3 fois sans étape cochée signalé sur la fiche projet", async () => {
    const { clientId } = await projectFromQuote("THREE");
    const [fiche] = await listClientProjects(clientId);
    expect(fiche!.deposit2).toEqual({ locked: false, missingStep: true });
  });
});
