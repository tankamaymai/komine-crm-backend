-- 前受金一括登録の単位を識別する（取り消し用）
ALTER TABLE "billings" ADD COLUMN "prepaid_batch_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "prepaid_batch_id" TEXT;

CREATE INDEX "billings_prepaid_batch_id_idx" ON "billings"("prepaid_batch_id");
CREATE INDEX "payments_prepaid_batch_id_idx" ON "payments"("prepaid_batch_id");
