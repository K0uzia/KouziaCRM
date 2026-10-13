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
import { euros } from "@/lib/format";

export type RevenuePoint = {
  label: string;
  ca: number;
  urssaf: number;
  tresorerie: number;
  salaire: number;
  cfe: number;
};

const euro = (v: number) => euros(v, 0);

export default function RevenueChart({ data }: { data: RevenuePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} barCategoryGap="18%" barGap={2}>
        <defs>
          <linearGradient id="barCa" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--primary)" />
            <stop offset="100%" stopColor="var(--primary-hover)" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 12, fill: "var(--muted)" }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 12, fill: "var(--muted)" }}
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
        <Bar dataKey="urssaf" fill="var(--danger)" name="URSSAF" radius={[6, 6, 0, 0]} maxBarSize={28} />
        <Bar dataKey="salaire" fill="var(--success)" name="Salaire" radius={[6, 6, 0, 0]} maxBarSize={28} />
        <Bar
          dataKey="tresorerie"
          fill="var(--info)"
          name="Trésorerie"
          radius={[6, 6, 0, 0]}
          maxBarSize={28}
        />
        <Bar dataKey="cfe" fill="var(--accent-2)" name="CFE" radius={[6, 6, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}
