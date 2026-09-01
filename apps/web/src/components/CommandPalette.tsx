import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faFileInvoice,
  faFileLines,
  faFileCircleMinus,
  faUsers,
  faTag,
  faArrowRight,
  faPlus,
} from "@fortawesome/free-solid-svg-icons";
import { api, formatEUR } from "@/lib/api";
import {
  invoiceStatusLabel,
  quoteStatusLabel,
} from "@/lib/format";

type SearchClient = {
  id: string;
  displayName: string;
  clientNumber: string | null;
  city: string | null;
  type: string;
};

type SearchDocument = {
  id: string;
  number: string | null;
  documentType: "INVOICE" | "CREDIT_NOTE" | "QUOTE";
  status: string;
  quoteStatus: string | null;
  totalCents: number;
  clientName: string;
};

type SearchService = {
  id: string;
  name: string;
  unitPriceCents: number;
  active: boolean;
  isSubscription: boolean;
};

type SearchResult = {
  clients: SearchClient[];
  documents: SearchDocument[];
  services: SearchService[];
};

const NAV_ITEMS = [
  { label: "Accueil", to: "/", keywords: "dashboard home" },
  { label: "Clients", to: "/clients", keywords: "activité contact" },
  { label: "Messages", to: "/inbox", keywords: "email mail activité" },
  { label: "Avis", to: "/avis", keywords: "témoignage avis client activité" },
  { label: "Devis", to: "/quotes", keywords: "proposition facturation" },
  { label: "Factures", to: "/invoices", keywords: "facturation" },
  { label: "Encaissements", to: "/payments", keywords: "paiement facturation" },
  { label: "Livre de recettes", to: "/receipts", keywords: "registre facturation" },
  { label: "Tarifs", to: "/services", keywords: "prestation catalogue offre" },
  { label: "Abonnements", to: "/abonnements", keywords: "récurrent mrr offre" },
  { label: "Virements reçus", to: "/banque", keywords: "revolut banque finances" },
  { label: "Démarches à faire", to: "/obligations", keywords: "urssaf cfe finances" },
  { label: "Historique URSSAF", to: "/urssaf", keywords: "cotisations finances" },
  { label: "Réglages", to: "/settings", keywords: "entreprise" },
];

const QUICK_ACTIONS = [
  { label: "Nouveau devis", to: "/quotes?new=1" },
  { label: "Nouvelle facture", to: "/invoices?new=1" },
  { label: "Nouveau client", to: "/clients?new=1" },
  { label: "Écrire un message", to: "/inbox/compose" },
];

const GROUP_CLASS =
  "px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-[var(--muted)]";

const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm text-[var(--text)] data-[selected=true]:bg-[var(--primary-soft)] data-[selected=true]:text-[var(--primary)]";

function docIcon(type: SearchDocument["documentType"]) {
  if (type === "QUOTE") return faFileLines;
  if (type === "CREDIT_NOTE") return faFileCircleMinus;
  return faFileInvoice;
}

function docKindLabel(type: SearchDocument["documentType"]) {
  if (type === "QUOTE") return "Devis";
  if (type === "CREDIT_NOTE") return "Avoir";
  return "Facture";
}

function docHref(doc: SearchDocument) {
  return doc.documentType === "QUOTE" ? `/quotes/${doc.id}` : `/invoices/${doc.id}`;
}

function docStatusLabel(doc: SearchDocument) {
  if (doc.documentType === "QUOTE") {
    return quoteStatusLabel[doc.quoteStatus ?? doc.status] ?? doc.quoteStatus ?? doc.status;
  }
  return invoiceStatusLabel[doc.status] ?? doc.status;
}

const EMPTY_RESULT: SearchResult = { clients: [], documents: [], services: [] };

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult>(EMPTY_RESULT);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults(EMPTY_RESULT);
    setSearching(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (q.length < 1) {
      setResults(EMPTY_RESULT);
      setSearching(false);
      return;
    }

    setSearching(true);
    const id = ++requestId.current;
    debounceRef.current = setTimeout(() => {
      api<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`)
        .then((data) => {
          if (id === requestId.current) setResults(data);
        })
        .catch(() => {
          if (id === requestId.current) setResults(EMPTY_RESULT);
        })
        .finally(() => {
          if (id === requestId.current) setSearching(false);
        });
    }, 180);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, query]);

  function go(to: string) {
    onOpenChange(false);
    navigate(to);
  }

  const hasQuery = query.trim().length > 0;

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Recherche"
      shouldFilter
      loop
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[10vh]"
    >
      <div
        className="fixed inset-0 bg-[var(--text)]/30 backdrop-blur-[2px]"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Client, facture, devis, tarif, page…"
          className="w-full border-b border-[var(--border)] bg-transparent px-4 py-3.5 text-[15px] text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
        />
        <Command.List className="max-h-[62vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-sm text-[var(--muted)]">
            {searching
              ? "Recherche…"
              : hasQuery
                ? "Aucun résultat pour cette recherche."
                : "Tapez un nom, un numéro, un tarif…"}
          </Command.Empty>

          {results.clients.length > 0 ? (
            <Command.Group heading="Clients" className={GROUP_CLASS}>
              {results.clients.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`client ${c.displayName} ${c.clientNumber ?? ""} ${c.city ?? ""}`}
                  onSelect={() => go(`/clients/${c.id}`)}
                  className={`${ITEM_CLASS} justify-between`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <FontAwesomeIcon icon={faUsers} className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="truncate font-medium">{c.displayName}</span>
                  </span>
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    {c.clientNumber ?? ""}
                    {c.city ? ` · ${c.city}` : ""}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {results.documents.length > 0 ? (
            <Command.Group heading="Documents" className={GROUP_CLASS}>
              {results.documents.map((d) => (
                <Command.Item
                  key={d.id}
                  value={`document ${d.number ?? ""} ${d.clientName} ${docKindLabel(d.documentType)}`}
                  onSelect={() => go(docHref(d))}
                  className={`${ITEM_CLASS} justify-between`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <FontAwesomeIcon
                      icon={docIcon(d.documentType)}
                      className="h-3.5 w-3.5 shrink-0 opacity-60"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {d.number ?? "Brouillon"} · {d.clientName}
                      </span>
                      <span className="block text-xs text-[var(--muted)]">
                        {docKindLabel(d.documentType)} · {docStatusLabel(d)}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-[var(--muted)]">
                    {formatEUR(d.totalCents)}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {results.services.length > 0 ? (
            <Command.Group heading="Tarifs" className={GROUP_CLASS}>
              {results.services.map((s) => (
                <Command.Item
                  key={s.id}
                  value={`tarif ${s.name}`}
                  onSelect={() => go("/services")}
                  className={`${ITEM_CLASS} justify-between`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <FontAwesomeIcon icon={faTag} className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="truncate font-medium">{s.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    {formatEUR(s.unitPriceCents)}
                    {s.isSubscription ? " / mois" : ""}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {!hasQuery ? (
            <>
              <Command.Group heading="Aller à" className={GROUP_CLASS}>
                {NAV_ITEMS.map((item) => (
                  <Command.Item
                    key={item.to}
                    value={`${item.label} ${item.keywords}`}
                    onSelect={() => go(item.to)}
                    className={ITEM_CLASS}
                  >
                    <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3 opacity-40" />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading="Créer" className={GROUP_CLASS}>
                {QUICK_ACTIONS.map((item) => (
                  <Command.Item
                    key={item.to}
                    value={`créer ${item.label}`}
                    onSelect={() => go(item.to)}
                    className={ITEM_CLASS}
                  >
                    <FontAwesomeIcon icon={faPlus} className="h-3 w-3 opacity-50" />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>
            </>
          ) : null}
        </Command.List>
        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">
          <span>↑↓ naviguer · ↵ ouvrir · esc fermer</span>
          {hasQuery && searching ? <span>Recherche…</span> : null}
        </div>
      </div>
    </Command.Dialog>
  );
}
