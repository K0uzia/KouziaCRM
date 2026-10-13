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

export type MonthlyFlow = {
  key: string;
  encaisseCents: number;
  urssafCents: number;
  cfeCents: number;
  tresorerieCents: number;
  verseCents: number;
  salaireDisponibleCents: number;
};

const euro = (v: number) => euros(Math.abs(v), 0);
const shortMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(new Date(y, m - 1, 1)).replace(".", "");
};

/**
 * Flux par mois : entrées (encaissé) au-dessus de l'axe, provisions et retraits en dessous,
 * courbe du salaire disponible cumulé. Les versements Stripe n'y figurent pas (compte pro).
 */
export default function FlowsChart({ flows }: { flows: MonthlyFlow[] }) {
  const data = flows.map((f) => ({
    label: shortMonth(f.key),
    encaisse: f.encaisseCents / 100,
    urssaf: -f.urssafCents / 100,
    cfe: -f.cfeCents / 100,
    tresorerie: -f.tresorerieCents / 100,
    retrait: -f.verseCents / 100,
    salaire: f.salaireDisponibleCents / 100,
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
          formatter={(value, name) => [euro(Number(value ?? 0)), String(name)]}
          contentStyle={{
            background: "var(--surface-raised)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            color: "var(--text)",
            fontSize: "12px",
          }}
          cursor={{ fill: "rgb(139 92 246 / 0.08)" }}
        />
        {/* Ordre des séries (entrées puis sorties), pas l'ordre alphabétique par défaut. */}
        <Legend itemSorter={null} wrapperStyle={{ fontSize: 12, color: "var(--muted)", paddingTop: 8 }} />
        <Bar dataKey="encaisse" stackId="flux" fill="var(--primary)" name="Encaissé" maxBarSize={26} />
        <Bar dataKey="urssaf" stackId="flux" fill="var(--danger)" name="URSSAF" maxBarSize={26} />
        <Bar dataKey="cfe" stackId="flux" fill="var(--accent-2)" name="CFE" maxBarSize={26} />
        <Bar dataKey="tresorerie" stackId="flux" fill="var(--info)" name="Trésorerie" maxBarSize={26} />
        <Bar dataKey="retrait" stackId="flux" fill="var(--warning)" name="Retraits" maxBarSize={26} />
        <Line
          type="monotone"
          dataKey="salaire"
          stroke="var(--success)"
          strokeWidth={2.5}
          dot={{ r: 3, fill: "var(--success)" }}
          name="Salaire dispo."
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
