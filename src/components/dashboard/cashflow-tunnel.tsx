"use client";

import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBriefcase,
  faPiggyBank,
  faShieldHalved,
  faWallet,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { formatEUR } from "@/lib/money";
import { formatPercentFromBps } from "@/lib/urssaf";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  InvoiceSearch,
  type InvoiceSearchHit,
} from "@/components/dashboard/invoice-search";
import type { CashflowScope } from "@/lib/finance/cashflow-service";

export type CashflowData = {
  scope?: CashflowScope;
  periodLabel?: string;
  periodKey?: string;
  year: number;
  month: number;
  totalEncaisseCents: number;
  urssafCents: number;
  urssafEffectiveBps: number;
  fraisCents: number;
  fraisBps: number;
  placementsCents: number;
  placementsBps: number;
  reservedCents: number;
  resteNetCents: number;
  social?: {
    cotisationsCents: number;
    cfpCents: number;
    impotLiberatoireCents: number;
    impotRevenuMensuelCents: number;
  };
};

const SCOPE_TABS: { value: CashflowScope; label: string }[] = [
  { value: "week", label: "Semaine" },
  { value: "month", label: "Mois" },
  { value: "quarter", label: "Trimestre" },
  { value: "year", label: "Année" },
];

function ThinProgress({
  percent,
  barClassName,
}: {
  percent: number;
  barClassName: string;
}) {
  const width = Math.min(100, Math.max(0, percent));
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-100">
      <div
        className={cn("h-1.5 rounded-full transition-all duration-500", barClassName)}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

function EnvelopeRow({
  title,
  amountCents,
  rateBps,
  icon,
  iconClass,
  barClass,
  amountPrefix = "−",
}: {
  title: string;
  amountCents: number;
  rateBps: number;
  icon: IconDefinition;
  iconClass: string;
  barClass: string;
  amountPrefix?: string;
}) {
  return (
    <div className="space-y-2 border-b border-gray-100 py-4 last:border-0 last:pb-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FontAwesomeIcon icon={icon} className={cn("h-3.5 w-3.5 shrink-0", iconClass)} />
          <span className="truncate text-sm font-medium text-gray-800">{title}</span>
          <span className="text-xs text-gray-400">{formatPercentFromBps(rateBps)}</span>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">
          {amountPrefix} {formatEUR(amountCents)}
        </span>
      </div>
      <ThinProgress percent={rateBps / 100} barClassName={barClass} />
    </div>
  );
}

type Props = {
  cashflow: CashflowData;
  scope: CashflowScope;
  onScopeChange: (scope: CashflowScope) => void;
  invoiceId: string | null;
  onInvoiceChange: (invoiceId: string | null) => void;
};

export function CashflowTunnel({
  cashflow,
  scope,
  onScopeChange,
  invoiceId,
  onInvoiceChange,
}: Props) {
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const simulating = Boolean(invoiceId);
  const salaireBps =
    cashflow.totalEncaisseCents > 0
      ? Math.round((cashflow.resteNetCents / cashflow.totalEncaisseCents) * 10_000)
      : 0;

  function handleInvoiceSelect(hit: InvoiceSearchHit | null) {
    if (!hit) {
      setSelectedLabel(null);
      onInvoiceChange(null);
      return;
    }
    setSelectedLabel(`${hit.number ?? "—"} · ${hit.displayName}`);
    onInvoiceChange(hit.id);
  }

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-col gap-4 border-b border-gray-200 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Tunnel de cashflow</h2>
          <p className="text-xs text-gray-400">
            {simulating
              ? cashflow.periodLabel ?? "Simulation facture"
              : cashflow.periodLabel ?? "Période"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <InvoiceSearch
            selectedId={invoiceId}
            selectedLabel={selectedLabel ?? cashflow.periodLabel}
            onSelect={handleInvoiceSelect}
          />

          <Tabs
            value={scope}
            onValueChange={(v) => onScopeChange(v as CashflowScope)}
          >
            <TabsList>
              {SCOPE_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="px-6 py-6 sm:px-8 sm:py-8">
        <div className="pb-5">
          <p className="text-sm text-gray-500">CA Encaissé</p>
          <p className="mt-1 text-4xl font-bold tracking-tight text-gray-900 tabular-nums sm:text-5xl">
            {formatEUR(cashflow.totalEncaisseCents)}
          </p>
        </div>

        <div className="border-t border-gray-200 pt-1">
          <EnvelopeRow
            title="URSSAF"
            amountCents={cashflow.urssafCents}
            rateBps={cashflow.urssafEffectiveBps}
            icon={faShieldHalved}
            iconClass="text-red-500"
            barClass="bg-red-500"
          />
          <EnvelopeRow
            title="Charges & CFE"
            amountCents={cashflow.fraisCents}
            rateBps={cashflow.fraisBps}
            icon={faBriefcase}
            iconClass="text-orange-500"
            barClass="bg-orange-500"
          />
          <EnvelopeRow
            title="Trésorerie / Épargne"
            amountCents={cashflow.placementsCents}
            rateBps={cashflow.placementsBps}
            icon={faPiggyBank}
            iconClass="text-sky-500"
            barClass="bg-sky-500"
          />
          <EnvelopeRow
            title="Salaire Net"
            amountCents={cashflow.resteNetCents}
            rateBps={salaireBps}
            icon={faWallet}
            iconClass="text-emerald-600"
            barClass="bg-emerald-500"
            amountPrefix="="
          />
        </div>
      </div>
    </section>
  );
}

export const CashflowSummary = CashflowTunnel;
