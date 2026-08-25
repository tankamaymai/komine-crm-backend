import { z } from 'zod';

import { PLOT_MAP_IDS } from '../plots/services/plotMapSpecs';

export type { PlotMapId } from '../plots/services/plotMapSpecs';

export const plotMapQuerySchema = z.object({
  mapId: z.string().refine((value) => PLOT_MAP_IDS.includes(value), {
    message: '不明な区画図です',
  }),
});
