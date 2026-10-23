import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** File « E-mails à valider » (E6) : e-mails automatiques au client, en attente ou refusés (30 derniers jours). */
export type ReviewItem = {
  id: string;
  status: "REVIEW" | "REJECTED";
  to: string;
  subject: string;
  clientId: string | null;
  clientName: string | null;
  documentId: string | null;
  documentNumber: string | null;
  family: string | null;
  familyLabel: string | null;
  origin: string | null;
  originLabel: string | null;
  clientWaiting: boolean;
  attachments: Array<{ filename: string; bytes: number }>;
  createdAt: string;
  reviewedAt: string | null;
  rejectReason: string | null;
};

export type ReviewDetail = ReviewItem & { text: string; hasCustomLayout: boolean };
export type ReviewQueue = { pending: ReviewItem[]; rejected: ReviewItem[] };
export type ReviewFamilySetting = { id: string; label: string; alwaysReviewed: boolean };

/** Événement émis après une validation ou un refus : la pastille se met à jour sans attendre la minute suivante. */
export const REVIEW_CHANGED_EVENT = "kouzia:email-review-changed";

/** Pastille de la navigation : e-mails en attente de validation, relus chaque minute et après chaque action. */
export function usePendingEmailReviews(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ count: number }>("/api/emails/review/count")
        .then((r) => alive && setCount(r.count))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    window.addEventListener(REVIEW_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(REVIEW_CHANGED_EVENT, load);
    };
  }, []);
  return count;
}
