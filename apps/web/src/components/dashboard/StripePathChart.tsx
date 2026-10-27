import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { euros } from "@/lib/format";
import type { FluxMonth } from "@/pages/StripePayoutsPage";

const euro = (v: number) => euros(Math.abs(v), 0);
const shortMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(new Date(y, m - 1, 1)).replace(".", "");
};

/**
 * Chemin de l'argent encaissé : par Stripe ou en direct (au-dessus), frais, retenues et argent encore
 * chez Stripe (en dessous) ; la courbe montre ce qui est arrivé sur le compte pro. Un point d'alerte
 * marque un mois dont les versements ne correspondent pas.
 */
export default function StripePathChart({ months }: { months: FluxMonth[] }) {
  const data = months.map((m) => ({
    label: shortMonth(m.key),
    stripe: m.encaisseStripeCents / 100,
    direct: m.directCents / 100,
    frais: -m.feeCents / 100,
    retenues: -m.refundsDisputesCents / 100,
    attente: -m.pendingCents / 100,
    arrive: (m.verseCents + m.directCents) / 100,
    ecart: m.gapCents !== 0 ? (m.encaisseStripeCents + m.directCents) / 100 : null,
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} stackOffset="sign" barCategoryGap="22%">
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted)" }}
          axisLine={false}
          tickLine={false}
          width={48}
          tickFormatter={(v) => `${Math.round(Number(v))}`}
        />
        <ReferenceLine y={0} stroke="var(--border)" />
        <Tooltip
          formatter={(value, name) => [name === "Écart à vérifier" ? "versements à vérifier" : euro(Number(value ?? 0)), String(name)]}
          contentStyle={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            color: "var(--text)",
            fontSize: "12px",
          }}
          cursor={{ fill: "var(--chart-cursor)" }}
        />
        <Legend itemSorter={null} wrapperStyle={{ fontSize: 12, color: "var(--muted)", paddingTop: 8 }} />
        <Bar dataKey="stripe" stackId="flux" fill="var(--primary)" name="Stripe" maxBarSize={26} />
        <Bar dataKey="direct" stackId="flux" fill="var(--accent-2)" name="Direct" maxBarSize={26} />
        <Bar dataKey="frais" stackId="flux" fill="var(--danger)" name="Frais" maxBarSize={26} />
        <Bar dataKey="retenues" stackId="flux" fill="var(--warning)" name="Remb. et litiges" maxBarSize={26} />
        <Bar dataKey="attente" stackId="flux" fill="var(--info)" name="Chez Stripe" maxBarSize={26} />
        <Line
          type="monotone"
          dataKey="arrive"
          stroke="var(--success)"
          strokeWidth={2.5}
          dot={{ r: 3, fill: "var(--success)" }}
          name="Arrivé au compte pro"
          isAnimationActive={false}
        />
        <Line
          dataKey="ecart"
          stroke="none"
          dot={{ r: 6, fill: "var(--warning)", stroke: "var(--bg)", strokeWidth: 2 }}
          name="Écart à vérifier"
          legendType="circle"
          isAnimationActive={false}
          connectNulls={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
