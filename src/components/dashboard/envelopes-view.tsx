"use client";

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faLandmark,
  faLightbulb,
  faWallet,
} from "@fortawesome/free-solid-svg-icons";
import { formatEUR } from "@/lib/money";
import { formatPercentFromBps } from "@/lib/urssaf";
import { envelopeFillPercent } from "@/lib/finance/envelopes";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type EnvelopesData = {
  caCents: number;
  urssafCents: number;
  treasuryCents: number;
  salaryNetCents: number;
  rates: { urssafBps: number; treasuryBps: number; salaryBps: number };
};

type PublicodesData = {
  cotisationsCents: number;
  monthlyEuros: number;
  rule: string;
};

type MonthlyCa = { month: number; cents: number };

const MONTHS = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];

function EnvelopeCard({
  title,
  amountCents,
  rateBps,
  caCents,
  icon,
  tone,
  hint,
}: {
  title: string;
  amountCents: number;
  rateBps: number;
  caCents: number;
  icon: typeof faLandmark;
  tone: "red" | "amber" | "emerald";
  hint: string;
}) {
  const fill = envelopeFillPercent(amountCents, caCents);
  const tones = {
    red: {
      card: "border-red-200 bg-red-50/80",
      title: "text-red-800",
      bar: "bg-red-600",
      icon: "text-red-700",
    },
    amber: {
      card: "border-amber-200 bg-amber-50/80",
      title: "text-amber-900",
      bar: "bg-amber-500",
      icon: "text-amber-700",
    },
    emerald: {
      card: "border-emerald-200 bg-emerald-50/80",
      title: "text-emerald-900",
      bar: "bg-emerald-600",
      icon: "text-emerald-700",
    },
  }[tone];

  return (
    <Card className={cn("border transition-shadow hover:shadow-md", tones.card)}>
      <CardHeader className="pb-2">
        <CardDescription className={cn("flex items-center gap-2 font-medium", tones.title)}>
          <FontAwesomeIcon icon={icon} className={cn("h-4 w-4", tones.icon)} />
          {title}
        </CardDescription>
        <CardTitle className={cn("text-2xl", tones.title)}>{formatEUR(amountCents)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="h-2.5 overflow-hidden rounded-full bg-white/70">
          <div
            className={cn("h-full rounded-full transition-all duration-500", tones.bar)}
            style={{ width: `${fill}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {formatPercentFromBps(rateBps)} du CA · {hint}
        </p>
      </CardContent>
    </Card>
  );
}

export function EnvelopesView({
  envelopes,
  publicodes,
  monthlyCa,
  year,
}: {
  envelopes: EnvelopesData;
  publicodes: PublicodesData;
  monthlyCa: MonthlyCa[];
  year: number;
}) {
  const maxMonth = Math.max(1, ...monthlyCa.map((m) => m.cents));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-[family-name:var(--font-display)] text-xl text-primary">
          Enveloppes budgétaires
        </h2>
        <p className="text-sm text-muted-foreground">
          Répartition du CA encaissé {year} (règle métier Kouzia)
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <EnvelopeCard
          title="URSSAF"
          amountCents={envelopes.urssafCents}
          rateBps={envelopes.rates.urssafBps}
          caCents={envelopes.caCents}
          icon={faLandmark}
          tone="red"
          hint="charges sociales à provisionner"
        />
        <EnvelopeCard
          title="Trésorerie / Frais"
          amountCents={envelopes.treasuryCents}
          rateBps={envelopes.rates.treasuryBps}
          caCents={envelopes.caCents}
          icon={faLightbulb}
          tone="amber"
          hint="CFE, RCP, abos, matériel"
        />
        <EnvelopeCard
          title="Salaire net"
          amountCents={envelopes.salaryNetCents}
          rateBps={envelopes.rates.salaryBps}
          caCents={envelopes.caCents}
          icon={faWallet}
          tone="emerald"
          hint="disponible dirigeant"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Calcul légal Publicodes (mon-entreprise)</CardTitle>
          <CardDescription>
            AE · EI · BNC libéral non réglementé — indicatif, distinct des enveloppes
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end justify-between gap-3 text-sm">
          <div>
            <p className="text-2xl font-semibold text-primary">
              {formatEUR(publicodes.cotisationsCents)}
            </p>
            <p className="text-xs text-muted-foreground">
              ≈ {publicodes.monthlyEuros.toFixed(2)} €/mois · {publicodes.rule}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">CA encaissé mensuel {year}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-36 items-end gap-1.5">
            {monthlyCa.map((m) => {
              const h = Math.max(4, Math.round((m.cents / maxMonth) * 100));
              return (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-primary/80 transition-all duration-300 hover:bg-primary"
                    style={{ height: `${h}%` }}
                    title={formatEUR(m.cents)}
                  />
                  <span className="text-[10px] text-muted-foreground">{MONTHS[m.month - 1]}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
