import { Request, Response } from 'express';

import prisma from '../../db/prisma';
import { joinPermitPlotNumbers } from '../services/permitPlotNumbers';

/**
 * GET /plots/contractor/:customerId/plots
 * 契約中の人が持っている区画番号を、許可証1枚に書くための並びで返す。
 */
export const getContractorPlots = async (req: Request, res: Response): Promise<void> => {
  const { customerId } = req.params as { customerId: string };

  const rows = await prisma.contractPlot.findMany({
    where: {
      deleted_at: null,
      contract_status: 'active',
      saleContractRoles: {
        some: {
          customer_id: customerId,
          role: 'contractor',
          deleted_at: null,
          role_end_date: null,
        },
      },
    },
    select: {
      physicalPlot: {
        select: {
          area_name: true,
          display_number: true,
          plot_number: true,
        },
      },
    },
  });

  const plotNumber = joinPermitPlotNumbers(
    rows.map((row) => ({
      areaName: row.physicalPlot.area_name,
      displayNumber: row.physicalPlot.display_number,
      plotNumber: row.physicalPlot.plot_number,
    }))
  );

  res.status(200).json({
    success: true,
    data: { plotNumber },
  });
};
