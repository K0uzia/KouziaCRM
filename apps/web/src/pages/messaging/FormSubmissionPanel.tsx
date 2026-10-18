import { useId } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGlobe, faReply, faUserPlus } from "@fortawesome/free-solid-svg-icons";
import { Card } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import type { ClientPrefill } from "@/components/clients/ClientForm";
import { formatMailDateTime, formatPhoneFr } from "@/lib/format";

/** Message du formulaire de kouzia.com dans un fil (GET /api/emails/:threadId, formSubmission). */
export type FormSubmission = {
  messageId: string;
  receivedAt: string;
  fields: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    project: string | null;
    message: string | null;
  };
  client: { id: string; displayName: string } | null;
  /** Adresse du client (ou saisie dans le formulaire) : jamais l'expéditeur Web3Forms. */
  replyTo: string | null;
};

const LABELS: Array<[keyof FormSubmission["fields"], string]> = [
  ["name", "Nom"],
  ["email", "E-mail"],
  ["phone", "Téléphone"],
  ["company", "Structure"],
  ["project", "Projet"],
  ["message", "Message"],
];

/**
 * Encart en tête d'un fil venu du formulaire du site : client rattaché (lien vers sa fiche, « Répondre au
 * client » à son adresse) ou, sans client, « Créer le client » prérempli ; champs du formulaire en liste.
 */
export function FormSubmissionPanel({ form, onReply }: { form: FormSubmission; onReply: (to: string) => void }) {
  const titleId = useId();
  const prefill: ClientPrefill = {
    name: form.fields.name,
    email: form.fields.email,
    phone: form.fields.phone,
    company: form.fields.company,
  };
  const fields = LABELS.filter(([key]) => form.fields[key]);
  return (
    <Card className="mt-3 space-y-4 border border-[var(--primary)]/40 p-4" role="region" aria-labelledby={titleId}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <FontAwesomeIcon icon={faGlobe} className="h-3 w-3" aria-hidden />
            Formulaire de kouzia.com, le {formatMailDateTime(form.receivedAt)}
          </p>
          <h3 id={titleId} className="mt-1 text-base font-semibold break-words">
            {form.client ? (
              <>
                Client :{" "}
                <Link to={`/clients/${form.client.id}`} className="link inline-flex min-h-11 items-center">
                  {form.client.displayName}
                </Link>
              </>
            ) : (
              "Aucun client ne correspond à ce message"
            )}
          </h3>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:shrink-0" role="group" aria-label="Actions sur ce message">
          {form.client ? null : (
            <ButtonLink to="/clients?new=1" state={{ prefill }}>
              <FontAwesomeIcon icon={faUserPlus} className="h-4 w-4" aria-hidden />
              Créer le client
            </ButtonLink>
          )}
          {form.replyTo ? (
            <Button variant={form.client ? "primary" : "secondary"} onClick={() => onReply(form.replyTo!)}>
              <FontAwesomeIcon icon={faReply} className="h-4 w-4" aria-hidden />
              {form.client ? "Répondre au client" : "Répondre"}
            </Button>
          ) : null}
        </div>
      </div>
      {fields.length ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(7rem,max-content)_1fr]">
          {fields.map(([key, label]) => (
            <div key={key} className="contents">
              <dt className="text-[var(--muted)]">{label}</dt>
              <dd className={`min-w-0 break-words ${key === "message" ? "whitespace-pre-line" : ""}`}>
                {key === "phone" ? formatPhoneFr(form.fields.phone!) : form.fields[key]}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}
