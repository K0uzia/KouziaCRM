/**
 * Pièces comptables et preuves : 10 ans à compter de la clôture de l'exercice (art. L123-22 du code de commerce), soit
 * jusqu'au 31 décembre de l'année + 10 ; purgées à partir du 1er janvier suivant. Rend le début de l'année dont les
 * documents sont encore gardés. Module sans dépendance : lu par les archives PDF et par la purge du worker.
 */
export function accountingCutoff(now: Date = new Date()): Date {
  return new Date(now.getFullYear() - 10, 0, 1);
}

/** Document (ou règlement) daté d'un exercice clos depuis plus de 10 ans : son PDF a été ou sera purgé. */
export function isPastRetention(date: Date | null | undefined, now: Date = new Date()): boolean {
  return Boolean(date && date < accountingCutoff(now));
}
