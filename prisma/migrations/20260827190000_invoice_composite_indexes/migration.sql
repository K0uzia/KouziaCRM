-- CreateIndex
CREATE INDEX "Invoice_documentType_status_idx" ON "Invoice"("documentType", "status");

-- CreateIndex
CREATE INDEX "Invoice_documentType_quoteStatus_idx" ON "Invoice"("documentType", "quoteStatus");

-- CreateIndex
CREATE INDEX "Invoice_clientId_documentType_idx" ON "Invoice"("clientId", "documentType");
