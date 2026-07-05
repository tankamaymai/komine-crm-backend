-- 碑文（inscription）を廃止し、契約備考（notes）へ一本化する（システム確認 項目②）。
-- 業務要望: 「碑文」は項目として不要。今まで碑文に入れていた情報は備考へ移す。
-- 墓誌(gravestone_inscription) は別物のため対象外（残す）。

-- 1) 既存の inscription 値を notes（契約備考）へ結合してデータを保全する。
--    - notes が既に入っている場合は改行区切りで追記
--    - notes が空/NULL の場合は inscription をそのまま設定
--    - inscription が空/NULL の行は対象外（変更しない）
UPDATE "contract_plots"
SET "notes" = CASE
  WHEN "notes" IS NOT NULL AND btrim("notes") <> ''
    THEN "notes" || E'\n' || "inscription"
  ELSE "inscription"
END
WHERE "inscription" IS NOT NULL AND btrim("inscription") <> '';

-- 2) inscription カラムを削除する。
ALTER TABLE "contract_plots" DROP COLUMN "inscription";
