import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestimonialStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import {
  clientHasSubmittedTestimonial,
  listPublishedTestimonials,
  publishTestimonial,
  submitClientTestimonial,
} from "@/lib/testimonials/service.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

describe("testimonials", () => {
  it("enregistre un avis en attente et ne le publie pas", async () => {
    const client = await createClient();
    await submitClientTestimonial({
      clientId: client.id,
      authorName: "Camille Dupont",
      body: "Travail soigné, communication claire, je recommande sans hésiter.",
    });

    expect(await clientHasSubmittedTestimonial(client.id)).toBe(true);
    expect(await listPublishedTestimonials()).toHaveLength(0);
  });

  it("refuse un second avis tant que le premier n'est pas rejeté", async () => {
    const client = await createClient();
    await submitClientTestimonial({
      clientId: client.id,
      authorName: "Camille",
      body: "Travail soigné, communication claire, je recommande sans hésiter.",
    });

    await expect(
      submitClientTestimonial({
        clientId: client.id,
        authorName: "Camille",
        body: "Un autre message suffisamment long pour passer la validation.",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("expose l'avis après publication", async () => {
    const client = await createClient();
    const created = await submitClientTestimonial({
      clientId: client.id,
      authorName: "Camille Dupont",
      body: "Travail soigné, communication claire, je recommande sans hésiter.",
    });

    await publishTestimonial(created.id);
    const published = await listPublishedTestimonials();
    expect(published).toHaveLength(1);
    expect(published[0]?.authorName).toBe("Camille Dupont");
    expect(published[0]?.status).toBeUndefined();

    const row = await prisma.clientTestimonial.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.status).toBe(TestimonialStatus.PUBLISHED);
  });
});
