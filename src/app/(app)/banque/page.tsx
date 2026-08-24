"use client";

import useSWR from "swr";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { formatEUR } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Decl = {
  id: string;
  periodKey: string;
  periodicity: string;
  encaisseCents: number;
  amountDueCents: number;
  status: string;
  paidAt: string | null;
  paymentRef: string | null;
  deadline: string;
};

export default function BanquePage() {
  const { data, isLoading } = useSWR<Decl[]>("/api/urssaf/declarations");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Banque / Virements
        </h1>
        <p className="text-muted-foreground">Historique des déclarations URSSAF marquées payées</p>
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Virements URSSAF</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading && <Skeleton className="h-24 w-full" />}
          {!isLoading && (!data || data.length === 0) && (
            <p className="text-sm text-muted-foreground">
              Aucun virement enregistré. Utilisez « Marquer comme payé » sur le dashboard.
            </p>
          )}
          {data && data.length > 0 && (
            <ul className="divide-y">
              {data.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div>
                    <p className="font-medium">{d.periodKey}</p>
                    <p className="text-xs text-muted-foreground">
                      Échéance {format(new Date(d.deadline), "dd MMM yyyy", { locale: fr })}
                      {d.paidAt
                        ? ` · payé ${format(new Date(d.paidAt), "dd MMM yyyy", { locale: fr })}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="tabular-nums">{formatEUR(d.amountDueCents)}</span>
                    <Badge variant={d.status === "PAID" ? "success" : "warning"}>{d.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
