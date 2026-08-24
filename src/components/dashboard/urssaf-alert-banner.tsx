"use client";

import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCircleCheck,
  faShieldHalved,
} from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { mutate } from "swr";
import { formatEUR } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PriorPeriodStatus = {
  periodKey: string;
  periodLabel: string;
  paid: boolean;
  paidAt: string | null;
};

export type UrssafAlertData = {
  status: "paid" | "due" | "late" | "clear";
  periodKey: string;
  periodLabel: string;
  deadline: string;
  deadlineDay: number;
  daysLeft: number;
  encaisseCents: number;
  amountDueCents: number;
  paidAt: string | null;
  periodicity?: "MONTHLY" | "QUARTERLY";
  nextDeclarationDate: string;
  nextPaymentDate: string;
  nextPeriodLabel: string;
  priorPeriod: PriorPeriodStatus;
  previousQuarter: PriorPeriodStatus;
};

function formatDateFr(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Alerte URSSAF légale — indépendante du toggle temporel.
 * Affiche prochaine déclaration/paiement + statut du trimestre précédent.
 */
export function UrssafAlertBanner({ alert }: { alert: UrssafAlertData }) {
  const [loading, setLoading] = useState(false);
  const canMarkPaid = alert.status === "due" || alert.status === "late";
  const settled = alert.status === "clear" || alert.status === "paid" || alert.amountDueCents <= 0;

  async function markPaid() {
    setLoading(true);
    try {
      const res = await fetch("/api/urssaf/mark-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodKey: alert.periodKey }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Virement URSSAF enregistré");
      await mutate((key) => typeof key === "string" && key.startsWith("/api/dashboard"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  const late = alert.status === "late";
  const nextDate = formatDateFr(alert.nextPaymentDate);
  const q = alert.previousQuarter;

  return (
    <div
      role={settled ? "status" : "alert"}
      className={cn(
        "rounded-xl border bg-white px-4 py-3",
        late ? "border-red-200" : "border-gray-200",
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <FontAwesomeIcon
          icon={settled ? faCircleCheck : faShieldHalved}
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            settled ? "text-emerald-600" : late ? "text-red-600" : "text-amber-600",
          )}
        />

        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-medium text-gray-900">
            Prochaine déclaration &amp; paiement :{" "}
            <span className="tabular-nums">{nextDate}</span>
            <span className="font-normal text-gray-500">
              {" "}
              ({alert.nextPeriodLabel})
            </span>
          </p>

          {settled ? (
            <p className="text-sm text-gray-600">
              URSSAF {alert.periodLabel} :{" "}
              {alert.status === "paid" ? "réglée" : "à jour"}
              {alert.paidAt
                ? ` · ${new Date(alert.paidAt).toLocaleDateString("fr-FR")}`
                : ""}
            </p>
          ) : (
            <p className="text-sm text-gray-900">
              <span className="mr-1" aria-hidden>
                ⏳
              </span>
              {late
                ? `En retard de ${Math.abs(alert.daysLeft)} j`
                : alert.daysLeft === 0
                  ? "Dernier jour"
                  : `Plus que ${alert.daysLeft} j`}{" "}
              — {alert.periodLabel} :{" "}
              <span className="font-semibold tabular-nums">
                {formatEUR(alert.amountDueCents)}
              </span>
            </p>
          )}

          <p className="text-xs text-gray-500">
            Trimestre précédent ({q.periodLabel}) :{" "}
            {q.paid ? (
              <span className="text-emerald-700">
                payé
                {q.paidAt
                  ? ` le ${new Date(q.paidAt).toLocaleDateString("fr-FR")}`
                  : ""}
              </span>
            ) : (
              <span className="text-amber-700">non payé</span>
            )}
          </p>
        </div>

        {canMarkPaid ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={markPaid}
            disabled={loading}
            className="h-8 shrink-0 border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
          >
            {loading ? "…" : "Marquer comme payé"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
