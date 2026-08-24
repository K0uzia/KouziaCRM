export type ModalType = "client-create" | "client-edit" | "invoice-create" | "invoice-edit" | null;

export type ModalPayload = {
  clientId?: string;
  invoiceId?: string;
  title?: string;
  description?: string;
};
