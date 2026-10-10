import { renderToBuffer } from "@react-pdf/renderer";
import { InvoiceDocument, type InvoicePdfData } from "@/lib/pdf/invoice-document.js";
import {
  ReceiptsDocument,
  type ReceiptsPdfData,
} from "@/lib/pdf/receipts-document.js";

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const buffer = await renderToBuffer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (<InvoiceDocument {...data} />) as any,
  );
  return Buffer.from(buffer);
}

export async function renderReceiptsPdf(data: ReceiptsPdfData): Promise<Buffer> {
  const buffer = await renderToBuffer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (<ReceiptsDocument {...data} />) as any,
  );
  return Buffer.from(buffer);
}
