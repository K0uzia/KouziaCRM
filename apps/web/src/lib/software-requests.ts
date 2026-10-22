import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** Demandes d'utilisation d'un logiciel (Tracebay) reçues depuis le site. */
export type RequestStatus = "PENDING" | "CONVERTED" | "DECLINED";

export type SoftwareRequestItem = {
  id: string;
  software: string;
  status: RequestStatus;
  companyName: string;
  contactName: string;
  seats: string;
  duration: string;
  client: { id: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type SoftwareRequestDetail = SoftwareRequestItem & {
  edition: string;
  email: string;
  phone: string | null;
  need: string;
  noticeVersion: string;
  convertedAt: string | null;
  declinedAt: string | null;
  suggestedClient: { id: string; displayName: string; clientNumber: string | null } | null;
};

export const SOFTWARE_LABEL: Record<string, string> = { TRACEBAY: "Tracebay" };
export const STATUS_LABEL: Record<RequestStatus, string> = { PENDING: "En attente", CONVERTED: "Convertie", DECLINED: "Refusée" };
export const SEATS_LABEL: Record<string, string> = { "1": "1 poste", "2_5": "2 à 5 postes", "6_20": "6 à 20 postes", "20_PLUS": "Plus de 20 postes" };
export const EDITION_LABEL: Record<string, string> = { SERVER: "Serveur", PORTABLE: "Portable", UNSURE: "Pas encore décidé" };
export const DURATION_LABEL: Record<string, string> = {
  "3_MONTHS": "3 mois",
  "6_MONTHS": "6 mois",
  "12_MONTHS": "12 mois",
  UNSURE: "Pas encore décidé",
};

/** Pastille de la navigation : demandes en attente, relues chaque minute. */
export function usePendingSoftwareRequests(): number {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ pending: number }>("/api/software-requests/pending-count")
        .then((r) => alive && setPending(r.pending))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return pending;
}
