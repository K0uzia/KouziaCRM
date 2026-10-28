import { renderToBuffer } from "@react-pdf/renderer";
import { InvoiceDocument, type InvoicePdfData } from "@/lib/pdf/invoice-document.js";
import {
  ReceiptsDocument,
  type ReceiptsPdfData,
} from "@/lib/pdf/receipts-document.js";

/**
 * Devis à propositions : 1re passe qui mesure chaque proposition, et le bloc de fin, depuis le haut d'une page (page de
 * début et de fin),
 * pour savoir laquelle tient sur une page. @react-pdf déplace d'un bloc un élément insécable qui ne tient pas dans la
 * place restante, mais l'imprime tronqué s'il est plus long qu'une page : seules celles qui tiennent sont insécables.
 */
async function measureProposals(data: InvoicePdfData): Promise<{ proposals: Array<"FITS" | "LONG">; end: "FITS" | "LONG" }> {
  const pages = new Map<number, { start: number; end: number }>();
  await renderToBuffer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (
      <InvoiceDocument
        {...data}
        measureProposals
        onProposalPage={(i, edge, page) => pages.set(i, { start: 0, end: 0, ...pages.get(i), [edge]: page })}
      />
    ) as any,
  );
  const layoutOf = (i: number) => {
    const p = pages.get(i);
    return p && p.start > 0 && p.end > p.start ? ("LONG" as const) : ("FITS" as const);
  };
  return { proposals: (data.invoice.proposals ?? []).map((_, i) => layoutOf(i)), end: layoutOf(-1) };
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const layout = data.invoice.proposals?.length ? await measureProposals(data) : undefined;
  const buffer = await renderToBuffer(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (<InvoiceDocument {...data} proposalLayout={layout?.proposals} endLayout={layout?.end} />) as any,
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
