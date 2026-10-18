import type { FastifyRequest } from "fastify";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { describeDevice } from "@/lib/portal/auth.js";
import { formatDateTimeLongFr } from "@/lib/format-fr.js";

function fmtDateTime(d: Date): string {
  return formatDateTimeLongFr(d);
}

/** Connexion admin réussie depuis un appareil inconnu : email au titulaire du compte. */
export async function sendAdminNewDeviceAlert(to: string, request: FastifyRequest): Promise<void> {
  if (!(await isSmtpConfigured())) return;
  const device = describeDevice(request.headers["user-agent"]);
  const via = request.viaTunnel ? "Internet (tunnel)" : "réseau local ou Tailscale";
  const text = [
    "Bonjour,",
    "",
    "Une connexion à l'administration de l'ERP vient d'avoir lieu depuis un nouvel appareil :",
    "",
    `${device}, le ${fmtDateTime(new Date())}.`,
    `Accès : ${via}, adresse IP ${request.ip}.`,
    "",
    "C'est vous ? Il n'y a rien à faire.",
    "Ce n'est pas vous ? Sur le serveur, lancez `kouziactl 2fa-reset <email>` pour fermer toutes les sessions,",
    "puis changez le mot de passe et réactivez la double authentification.",
  ].join("\n");
  await mailEnqueue({ to, subject: "Nouvelle connexion à l'administration de l'ERP", text, kind: "admin_alert" });
}
