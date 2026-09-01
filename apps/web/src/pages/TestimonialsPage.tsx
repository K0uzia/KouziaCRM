import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";

type AdminTestimonial = {
  id: string;
  authorName: string;
  body: string;
  status: "PENDING" | "PUBLISHED" | "REJECTED";
  publishedAt: string | null;
  createdAt: string;
  client: { id: string; displayName: string; clientNumber: string | null };
};

const statusTone: Record<AdminTestimonial["status"], "amber" | "green" | "neutral"> = {
  PENDING: "amber",
  PUBLISHED: "green",
  REJECTED: "neutral",
};

const statusLabel: Record<AdminTestimonial["status"], string> = {
  PENDING: "À relire",
  PUBLISHED: "Publié",
  REJECTED: "Non publié",
};

export function TestimonialsPage() {
  const [rows, setRows] = useState<AdminTestimonial[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setRows(await api<AdminTestimonial[]>("/api/testimonials"));
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  async function act(id: string, path: "publish" | "unpublish" | "reject") {
    setBusyId(id);
    try {
      await api(`/api/testimonials/${id}/${path}`, { method: "POST" });
      await load();
      toast.success(
        path === "publish"
          ? "Avis publié sur le site"
          : path === "unpublish"
            ? "Avis retiré du site"
            : "Avis non publié",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action impossible");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Avis clients"
        subtitle="Les avis envoyés depuis le suivi. Publiez ceux que vous souhaitez afficher sur kouzia.fr."
      />

      {rows.length === 0 ? (
        <EmptyState title="Aucun avis pour le moment" />
      ) : (
        <ul className="space-y-4">
          {rows.map((row) => (
            <li key={row.id}>
              <Card className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{row.authorName}</p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {row.client.displayName}
                      {row.client.clientNumber ? ` · ${row.client.clientNumber}` : ""}
                      {" · "}
                      {formatDate(row.createdAt)}
                    </p>
                  </div>
                  <Badge tone={statusTone[row.status]}>{statusLabel[row.status]}</Badge>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">{row.body}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {row.status !== "PUBLISHED" ? (
                    <Button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => void act(row.id, "publish")}
                    >
                      Publier
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busyId === row.id}
                      onClick={() => void act(row.id, "unpublish")}
                    >
                      Retirer du site
                    </Button>
                  )}
                  {row.status !== "REJECTED" && row.status !== "PUBLISHED" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busyId === row.id}
                      onClick={() => void act(row.id, "reject")}
                    >
                      Ne pas publier
                    </Button>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
