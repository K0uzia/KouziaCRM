/**
 * Point d'entrée historique - réexporte le numberingService conforme CGI.
 * @deprecated Importer depuis numberingService.js
 */
export {
  allocateInvoiceNumber,
  allocateQuoteNumber,
  allocateCreditNoteNumber,
  generateDocumentNumber,
  formatDocumentNumber,
  formatInvoiceNumber,
  formatQuoteNumber,
  previewNextNumbers,
  reseedCountersFromDatabase,
  auditNumberingIntegrity,
  invoiceDocTypeToSeries,
  type AllocatedNumber,
  type NumberingPreview,
  type SeriesAudit,
} from "@/lib/invoices/numberingService.js";
