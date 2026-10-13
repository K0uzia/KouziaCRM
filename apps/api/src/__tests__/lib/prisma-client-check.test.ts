import { describe, expect, it } from "vitest";
import { checkPrismaClientUpToDate, schemaFields, staleClientDiff } from "@/lib/migration-check.js";

const SCHEMA = `
// commentaire
model OwnerWithdrawal {
  id          String   @id @default(cuid())
  amountCents Int
  /// Note facultative
  note        String?

  @@index([id])
}

model Payment {
  id String @id
  refundedCents Int @default(0)
}
`;

describe("client Prisma à jour avec le schéma", () => {
  it("lit les modèles et leurs champs, sans attributs ni commentaires", () => {
    const models = schemaFields(SCHEMA);
    expect([...models.keys()]).toEqual(["OwnerWithdrawal", "Payment"]);
    expect([...models.get("OwnerWithdrawal")!]).toEqual(["id", "amountCents", "note"]);
  });

  it("signale une table ou un champ absents du client (migrations appliquées sans generate)", () => {
    const client = [{ name: "Payment", fields: [{ name: "id" }] }];
    expect(staleClientDiff(SCHEMA, client)).toEqual(["OwnerWithdrawal", "Payment.refundedCents"]);
  });

  it("le client généré du dépôt est à jour", () => {
    expect(checkPrismaClientUpToDate()).toEqual([]);
  });
});
