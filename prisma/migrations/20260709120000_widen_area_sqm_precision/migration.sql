-- 面積カラムの精度拡張 numeric(5,2) → numeric(6,3)（システム確認 項目⑤）
-- レガシー実面積には 0.013 / 0.123 / 2.475 など小数第3位の値が存在するため、
-- 丸め損失なく格納できるよう精度を広げる（既存値はそのまま保持される安全な拡張）。
ALTER TABLE "physical_plots" ALTER COLUMN "area_sqm" TYPE NUMERIC(6, 3);
ALTER TABLE "contract_plots" ALTER COLUMN "contract_area_sqm" TYPE NUMERIC(6, 3);
