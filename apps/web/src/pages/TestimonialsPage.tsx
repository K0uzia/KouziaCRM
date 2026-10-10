import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { Tabs, useTabParam } from "@/components/ui/Tabs";

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

  const [tab, setTab] = useTabParam(["PENDING", "PUBLISHED", "REJECTED"] as const, "PENDING");
  const count = (st: AdminTestimonial["status"]) => rows.filter((r) => r.status === st).length;
  const visible = rows.filter((r) => r.status === tab);

  return (
    <div>
      <PageHeader
        title="Avis clients"
        subtitle="Avis laissés par vos clients depuis leur espace de suivi. Seuls les avis publiés apparaissent sur kouzia.com."
      />

      <Tabs
        label="Avis par statut"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "PENDING", label: "À relire", count: count("PENDING") },
          { id: "PUBLISHED", label: "Publiés", count: count("PUBLISHED") },
          { id: "REJECTED", label: "Non publiés", count: count("REJECTED") },
        ]}
      >
        {visible.length === 0 ? (
          <Card>
            <EmptyState
              title={tab === "PENDING" ? "Aucun avis à relire" : tab === "PUBLISHED" ? "Aucun avis publié" : "Aucun avis écarté"}
              hint={
                tab === "PENDING"
                  ? "Vos clients peuvent laisser un avis depuis leur espace de suivi, une fois un projet avancé."
                  : undefined
              }
            />
          </Card>
        ) : (
          <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {visible.map((row) => (
              <li key={row.id}>
                <Card className="flex h-full flex-col p-5">
                  <div className="flex items-start gap-3">
                    <Avatar name={row.authorName} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{row.authorName}</p>
                      <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
                        <Link to={`/clients/${row.client.id}`} className="hover:text-[var(--primary)]">
                          {row.client.displayName}
                        </Link>
                        {" · "}
                        {formatDate(row.createdAt)}
                      </p>
                    </div>
                    <Badge tone={statusTone[row.status]}>{statusLabel[row.status]}</Badge>
                  </div>
                  <blockquote className="mt-4 flex-1 whitespace-pre-wrap border-l-2 border-[var(--primary)]/60 pl-4 text-sm leading-relaxed">
                    {row.body}
                  </blockquote>
                  <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-[var(--border)] pt-4">
                    {row.status !== "REJECTED" && row.status !== "PUBLISHED" ? (
                      <Button variant="ghost" disabled={busyId === row.id} onClick={() => void act(row.id, "reject")}>
                        Ne pas publier
                      </Button>
                    ) : null}
                    {row.status !== "PUBLISHED" ? (
                      <Button disabled={busyId === row.id} onClick={() => void act(row.id, "publish")}>
                        Publier sur le site
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={busyId === row.id} onClick={() => void act(row.id, "unpublish")}>
                        Retirer du site
                      </Button>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Tabs>
    </div>
  );
}
