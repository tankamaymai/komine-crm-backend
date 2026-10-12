import { z } from 'zod';

import { PLOT_MAP_IDS } from '../plots/services/plotMapSpecs';

export type { PlotMapId } from '../plots/services/plotMapSpecs';

const mapIdSchema = z.string().refine((value) => PLOT_MAP_IDS.includes(value), {
  message: '不明な区画図です',
});

export const plotMapQuerySchema = z.object({
  mapId: mapIdSchema,
});

const cellIndex = z.number().int().min(0).max(999);

const plotMapCellPositionSchema = z.object({
  originRow: cellIndex,
  originCol: cellIndex,
  plotLabel: z.string().trim().min(1).max(50),
  row: cellIndex,
  col: cellIndex,
});

export const plotMapPositionsBodySchema = z
  .object({
    mapId: mapIdSchema,
    positions: z.array(plotMapCellPositionSchema).max(5000),
  })
  .superRefine((value, ctx) => {
    const origins = new Set<string>();
    const targets = new Set<string>();
    value.positions.forEach((position, index) => {
      const origin = `${position.originRow}-${position.originCol}`;
      const target = `${position.row}-${position.col}`;
      if (origins.has(origin)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['positions', index],
          message: '同じマスが二重に入っています',
        });
      }
      if (targets.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['positions', index],
          message: '同じ場所に二つのマスは置けません',
        });
      }
      origins.add(origin);
      targets.add(target);
    });
  });
