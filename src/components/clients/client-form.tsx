"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

type Props = {
  mode: "create" | "edit";
  clientId?: string;
  initial?: Record<string, string | null>;
  /** Affichage page (Card) ou contenu dialog */
  variant?: "page" | "modal";
  onSuccess?: (client: { id: string }) => void;
  onCancel?: () => void;
};

const empty = {
  type: "B2C",
  firstName: "",
  lastName: "",
  companyName: "",
  email: "",
  phone: "",
  siret: "",
  addressLine1: "",
  addressLine2: "",
  postalCode: "",
  city: "",
  country: "FRANCE",
  notes: "",
};

export function ClientForm({
  mode,
  clientId,
  initial,
  variant = "page",
  onSuccess,
  onCancel,
}: Props) {
  const router = useRouter();
  const [form, setForm] = useState({ ...empty, ...initial });
  const [loading, setLoading] = useState(false);
  const isModal = variant === "modal";

  useEffect(() => {
    if (initial) setForm({ ...empty, ...initial });
  }, [initial]);

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const payload = {
      ...form,
      email: form.email || null,
      phone: form.phone || null,
      siret: form.siret || null,
    };
    const res = await fetch(mode === "create" ? "/api/clients" : `/api/clients/${clientId}`, {
      method: mode === "create" ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setLoading(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(typeof data.error === "string" ? data.error : "Erreur de validation");
      return;
    }
    const client = await res.json();
    toast.success(mode === "create" ? "Client créé" : "Client mis à jour");
    if (onSuccess) {
      onSuccess(client);
      return;
    }
    router.push(`/clients/${client.id}`);
    router.refresh();
  }

  const formBody = (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="type"
            checked={form.type === "B2C"}
            onChange={() => set("type", "B2C")}
          />
          B2C (particulier)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="type"
            checked={form.type === "B2B"}
            onChange={() => set("type", "B2B")}
          />
          B2B (professionnel)
        </label>
      </div>

      {form.type === "B2C" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Prénom</Label>
            <Input value={form.firstName ?? ""} onChange={(e) => set("firstName", e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Nom *</Label>
            <Input
              required
              value={form.lastName ?? ""}
              onChange={(e) => set("lastName", e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Raison sociale *</Label>
            <Input
              required
              value={form.companyName ?? ""}
              onChange={(e) => set("companyName", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>SIRET</Label>
            <Input
              value={form.siret ?? ""}
              onChange={(e) => set("siret", e.target.value.replace(/\s/g, ""))}
              placeholder="14 chiffres"
              maxLength={14}
            />
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Email</Label>
          <Input type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Téléphone</Label>
          <Input value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Adresse</Label>
        <Input value={form.addressLine1 ?? ""} onChange={(e) => set("addressLine1", e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Complément</Label>
        <Input value={form.addressLine2 ?? ""} onChange={(e) => set("addressLine2", e.target.value)} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2">
          <Label>Code postal</Label>
          <Input value={form.postalCode ?? ""} onChange={(e) => set("postalCode", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Ville</Label>
          <Input value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Pays</Label>
          <Input value={form.country ?? "FRANCE"} onChange={(e) => set("country", e.target.value)} />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Notes</Label>
        <Textarea value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={loading}>
          {loading ? "Enregistrement…" : "Enregistrer"}
        </Button>
        {isModal ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Annuler
          </Button>
        ) : (
          <Link
            href="/clients"
            className="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm hover:bg-accent"
          >
            Annuler
          </Link>
        )}
      </div>
    </form>
  );

  if (isModal) return formBody;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-[family-name:var(--font-display)] text-xl">
          {mode === "create" ? "Nouveau client" : "Modifier le client"}
        </CardTitle>
      </CardHeader>
      <CardContent>{formBody}</CardContent>
    </Card>
  );
}
