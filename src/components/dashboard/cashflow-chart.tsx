"use client";

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
import type { CashflowChartPoint } from "@/lib/finance/cashflow-service";

const EUR = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

type Props = {
  data: CashflowChartPoint[];
};

/**
 * Barres empilées = même ventilation que le tunnel.
 * Hauteur totale = CA encaissé (URSSAF + Charges + Trésorerie + Salaire).
 */
export function CashflowChart({ data }: Props) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 sm:p-8">
      <div className="mb-6">
        <h2 className="text-sm font-semibold text-gray-900">Historique</h2>
        <p className="text-xs text-gray-400">
          Répartition du CA (même logique que le tunnel)
        </p>
      </div>

      <div className="h-64 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "#9ca3af", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fill: "#9ca3af", fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => EUR.format(v)}
              width={72}
            />
            <Tooltip
              cursor={{ fill: "#f9fafb" }}
              contentStyle={{
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                fontSize: 12,
                boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
              }}
              formatter={(value, name) => [EUR.format(Number(value ?? 0)), String(name)]}
              labelFormatter={(label, payload) => {
                const ca = payload?.[0]?.payload?.ca;
                return ca != null ? `${label} · CA ${EUR.format(ca)}` : String(label);
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "#6b7280", paddingTop: 8 }}
              iconType="circle"
              iconSize={8}
            />
            <Bar
              dataKey="urssaf"
              name="URSSAF"
              stackId="ca"
              fill="#ef4444"
              maxBarSize={40}
            />
            <Bar
              dataKey="charges"
              name="Charges & CFE"
              stackId="ca"
              fill="#f97316"
              maxBarSize={40}
            />
            <Bar
              dataKey="tresorerie"
              name="Trésorerie / Épargne"
              stackId="ca"
              fill="#0ea5e9"
              maxBarSize={40}
            />
            <Bar
              dataKey="salaire"
              name="Salaire Net"
              stackId="ca"
              fill="#22c55e"
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
