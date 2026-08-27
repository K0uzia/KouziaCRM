import { prisma } from "@/lib/prisma.js";
import { decrypt, encrypt } from "@/lib/crypto.js";
import {
  createPaymentDraft,
  isPayoutEnabled,
  isRevolutConfigured,
} from "@/lib/revolut/revolutService.js";
import { getScopedCashflow } from "@/lib/finance/cashflow-service.js";

export class PayoutError extends Error {
  constructor(
    message: string,
    public code: "DISABLED" | "NOT_CONFIGURED" | "NO_BENEFICIARY" | "AMOUNT" | "API",
  ) {
    super(message);
    this.name = "PayoutError";
  }
}

export async function upsertPersonalBeneficiary(input: {
  label: string;
  name: string;
  iban: string;
}) {
  const existing = await prisma.revolutBeneficiary.findFirst({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });
  const data = {
    label: input.label.trim() || "Compte personnel",
    nameEncrypted: encrypt(input.name.trim()),
    ibanEncrypted: encrypt(input.iban.replace(/\s+/g, "").toUpperCase()),
    active: true,
  };
  if (existing) {
    return prisma.revolutBeneficiary.update({ where: { id: existing.id }, data });
  }
  return prisma.revolutBeneficiary.create({ data });
}

export async function createSalaryPayoutDraft(opts?: {
  amountCents?: number;
  notes?: string | null;
}) {
  if (!isPayoutEnabled()) {
    throw new PayoutError(
      "Virements salaire désactivés (REVOLUT_PAYOUT_ENABLED)",
      "DISABLED",
    );
  }
  if (!isRevolutConfigured()) {
    throw new PayoutError("Revolut non configuré", "NOT_CONFIGURED");
  }

  const beneficiary = await prisma.revolutBeneficiary.findFirst({
    where: { active: true },
    orderBy: { createdAt: "asc" },
  });
  if (!beneficiary) {
    throw new PayoutError(
      "Aucun bénéficiaire personnel configuré",
      "NO_BENEFICIARY",
    );
  }

  let amountCents = opts?.amountCents;
  if (amountCents == null) {
    const cf = await getScopedCashflow("month");
    amountCents = cf.resteNetCents;
  }
  if (!amountCents || amountCents <= 0) {
    throw new PayoutError("Montant de salaire invalide ou nul", "AMOUNT");
  }

  const name = decrypt(beneficiary.nameEncrypted);
  const iban = decrypt(beneficiary.ibanEncrypted);

  const draft = await createPaymentDraft({
    amountCents,
    receiverName: name,
    receiverIban: iban,
    reference: "Salaire",
  });

  return prisma.salaryPayout.create({
    data: {
      amountCents,
      currency: "EUR",
      status: "PENDING_CONFIRMATION",
      revolutDraftId: draft.id,
      beneficiaryId: beneficiary.id,
      notes:
        opts?.notes ??
        "Brouillon Revolut : confirmer le virement dans l'application Revolut Business",
    },
  });
}

export async function listSalaryPayouts(limit = 50) {
  return prisma.salaryPayout.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { beneficiary: { select: { id: true, label: true } } },
  });
}
