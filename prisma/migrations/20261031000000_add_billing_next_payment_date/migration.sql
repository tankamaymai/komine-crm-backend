-- 窓口で「次に払う日」を請求につき1つ残す
ALTER TABLE "billings" ADD COLUMN IF NOT EXISTS "next_payment_date" DATE;
