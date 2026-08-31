import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type RevenuePoint = {
  label: string;
  ca: number;
  urssaf: number;
  tresorerie: number;
  salaire: number;
  cfe: number;
};

const euro = (v: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(v);

export default function RevenueChart({ data }: { data: RevenuePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} barCategoryGap="18%" barGap={2}>
        <defs>
          <linearGradient id="barCa" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="100%" stopColor="#a5b4fc" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          axisLine={false}
          tickLine={false}
          width={52}
          tickFormatter={(v) => `${Math.round(v)}`}
        />
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
        <Legend
          wrapperStyle={{ fontSize: 12, color: "var(--muted)", paddingTop: 8 }}
        />
        <Bar dataKey="ca" fill="url(#barCa)" name="Encaissé" radius={[6, 6, 0, 0]} maxBarSize={28} />
        <Bar dataKey="urssaf" fill="#fb7185" name="URSSAF" radius={[6, 6, 0, 0]} maxBarSize={28} />
        <Bar dataKey="salaire" fill="#34d399" name="Salaire" radius={[6, 6, 0, 0]} maxBarSize={28} />
        <Bar
          dataKey="tresorerie"
          fill="#60a5fa"
          name="Trésorerie"
          radius={[6, 6, 0, 0]}
          maxBarSize={28}
        />
        <Bar dataKey="cfe" fill="#fbbf24" name="CFE" radius={[6, 6, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}
