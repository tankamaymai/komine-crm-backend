-- 区画図で動かしたマスの場所（元の行・列 → 新しい行・列）
CREATE TABLE IF NOT EXISTS "plot_map_cell_positions" (
  "id" TEXT NOT NULL,
  "map_id" VARCHAR(50) NOT NULL,
  "origin_row" INTEGER NOT NULL,
  "origin_col" INTEGER NOT NULL,
  "plot_label" VARCHAR(50) NOT NULL,
  "row" INTEGER NOT NULL,
  "col" INTEGER NOT NULL,
  "updated_by" INTEGER,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plot_map_cell_positions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "plot_map_cell_positions_map_id_origin_row_origin_col_key"
  ON "plot_map_cell_positions"("map_id", "origin_row", "origin_col");

CREATE UNIQUE INDEX IF NOT EXISTS "plot_map_cell_positions_map_id_row_col_key"
  ON "plot_map_cell_positions"("map_id", "row", "col");
