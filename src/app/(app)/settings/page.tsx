"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Settings = {
  urssafPeriodicity: "MONTHLY" | "QUARTERLY";
  urssafDeadlineDay: number;
  treasuryRateBps: number;
  placementRateBps: number;
};

export default function SettingsPage() {
  const { data, isLoading, mutate } = useSWR<Settings>("/api/settings");
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Paramètres enregistrés");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !form) {
    return <Skeleton className="h-64 w-full max-w-xl" />;
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">Paramètres</h1>
        <p className="text-muted-foreground">URSSAF, trésorerie et enveloppes budgétaires</p>
      </div>

      <Card className="rounded-xl shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Déclarations URSSAF</CardTitle>
          <CardDescription>
            Les cotisations sont calculées par Publicodes (modele-social), pas un % fixe.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-5">
            <div className="space-y-2">
              <Label>Périodicité</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.urssafPeriodicity}
                onChange={(e) =>
                  setForm({
                    ...form,
                    urssafPeriodicity: e.target.value as "MONTHLY" | "QUARTERLY",
                  })
                }
              >
                <option value="MONTHLY">Mensuelle</option>
                <option value="QUARTERLY">Trimestrielle</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Jour limite de déclaration</Label>
              <Input
                type="number"
                min={1}
                max={28}
                value={form.urssafDeadlineDay}
                onChange={(e) =>
                  setForm({ ...form, urssafDeadlineDay: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Enveloppe frais & CFE (basis points, 1420 = 14,20 %)</Label>
              <Input
                type="number"
                value={form.treasuryRateBps}
                onChange={(e) =>
                  setForm({ ...form, treasuryRateBps: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-2">
              <Label>Enveloppe placements (basis points, 1000 = 10 %)</Label>
              <Input
                type="number"
                value={form.placementRateBps}
                onChange={(e) =>
                  setForm({ ...form, placementRateBps: Number(e.target.value) })
                }
              />
            </div>
            <Button type="submit" disabled={saving}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
