-- 合祀を一斉に解約する月（お盆 / 10月）と、人数が揃ってから年を出す印
ALTER TABLE "collective_burials"
  ADD COLUMN IF NOT EXISTS "starts_on_capacity" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "collective_burial_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "release_timing" VARCHAR(20) NOT NULL DEFAULT 'october',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "collective_burial_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "collective_burial_settings" ("id", "release_timing", "updated_at")
VALUES (1, 'october', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
