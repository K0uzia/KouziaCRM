import { reconcileObligationCalendarEvents } from "@/lib/google-calendar/reconcile.js";

/**
 * Alignement Google Calendar hors requête : une réconciliation fait plusieurs appels HTTP à Google par
 * obligation ouverte, en série (plusieurs secondes). Après une modification, elle part en arrière-plan ;
 * une seule tourne à la fois dans le processus, et une demande arrivée pendant ce temps la relance une fois.
 * Le worker la fait aussi toutes les 15 minutes (scripts/worker.ts).
 */
let enCours: Promise<void> | null = null;
let relancer = false;

export function planifierReconciliationGoogle(): void {
  if (enCours) {
    relancer = true;
    return;
  }
  enCours = (async () => {
    do {
      relancer = false;
      // Échec déjà journalisé une fois par reconcileObligationCalendarEvents ; l'interface n'attend pas.
      await reconcileObligationCalendarEvents().catch(() => undefined);
    } while (relancer);
  })().finally(() => {
    enCours = null;
  });
}

/** Tests : attend la fin de la réconciliation en arrière-plan, s'il y en a une. */
export async function reconciliationGoogleTerminee(): Promise<void> {
  while (enCours) await enCours;
}
