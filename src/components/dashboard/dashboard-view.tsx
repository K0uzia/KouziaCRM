"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import useSWR from "swr";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { formatEUR } from "@/lib/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CashflowTunnel, type CashflowData } from "@/components/dashboard/cashflow-tunnel";
import { UrssafAlertBanner, type UrssafAlertData } from "@/components/dashboard/urssaf-alert-banner";
import type { CashflowChartPoint, CashflowScope } from "@/lib/finance/cashflow-service";

const CashflowChart = dynamic(
  () =>
    import("@/components/dashboard/cashflow-chart").then((m) => m.CashflowChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-72 w-full rounded-xl" />,
  },
);

type DashboardData = {
  company: { legalName: string; tradeName: string | null };
  scope: CashflowScope;
  invoiceId: string | null;
  cashflow: CashflowData;
  chart: CashflowChartPoint[];
  echeance: UrssafAlertData;
  drafts: number;
  pendingWithBalance: Array<{
    id: string;
    number: string | null;
    displayName: string;
    remaining: number;
  }>;
};

export function DashboardView() {
  const [scope, setScope] = useState<CashflowScope>("month");
  const [invoiceId, setInvoiceId] = useState<string | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({ scope });
    if (invoiceId) params.set("invoiceId", invoiceId);
    return `/api/dashboard?${params.toString()}`;
  }, [scope, invoiceId]);

  const { data, error, isLoading, isValidating } = useSWR<DashboardData>(url, {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

  if (isLoading && !data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-10 w-36" />
        </div>
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-destructive">Impossible de charger le dashboard.</p>;
  }

  return (
    <div className={isValidating ? "space-y-6 opacity-90" : "space-y-6"}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
          Tableau de bord
        </h1>
        <Link
          href="/payments"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-4 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-50"
        >
          <FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" />
          Encaissement
        </Link>
      </header>

      <UrssafAlertBanner alert={data.echeance} />

      <CashflowTunnel
        cashflow={data.cashflow}
        scope={scope}
        onScopeChange={setScope}
        invoiceId={invoiceId}
        onInvoiceChange={setInvoiceId}
      />

      <CashflowChart data={data.chart} />

      {data.pendingWithBalance.length > 0 && (
        <Card className="rounded-xl border border-gray-200 bg-white shadow-none">
          <CardHeader className="px-6 pb-2 pt-6 sm:px-8">
            <CardTitle className="text-sm font-semibold text-gray-900">
              Factures émises non soldées
              {data.drafts > 0 ? (
                <span className="ml-2 text-xs font-normal text-gray-400">
                  · {data.drafts} brouillon(s)
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-6 pb-6 sm:px-8">
            <ul className="divide-y divide-gray-100 text-sm">
              {data.pendingWithBalance.map((inv) => (
                <li key={inv.id} className="flex justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="text-gray-700 hover:text-gray-900 hover:underline"
                  >
                    {inv.number} · {inv.displayName}
                  </Link>
                  <span className="shrink-0 tabular-nums text-gray-900">
                    {formatEUR(inv.remaining)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
