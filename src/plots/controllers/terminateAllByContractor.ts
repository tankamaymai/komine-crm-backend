/**
 * 人ごとの一括解約エンドポイント
 * POST /api/v1/plots/by-contractor/:customerId/terminate-all
 *
 * 指定した人が今の契約者になっている active な ContractPlot を、まとめて terminated にする。
 * 1件解約（terminateContract）と同じ更新・履歴・物理区画の再計算を、
 * 1つの Serializable トランザクションで行う。途中で失敗したら、どれも解約しない。
 * 顧客レコードは触らない（is_terminated にもしない）。
 */

import { Request, Response, NextFunction } from 'express';
import { ContractRole, ContractStatus, Prisma } from '@prisma/client';
import prisma from '../../db/prisma';
import { ValidationError } from '../../middleware/errorHandler';
import { recordEntityUpdated } from '../services/historyService';
import { contractStatusService } from '../services/contractStatusService';
import { updatePhysicalPlotStatus } from '../utils';
import type { TerminateContractRequest } from '../../validations/plotValidation';

export const terminateAllByContractor = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const customerId = (req.params as Record<string, string>)['customerId'] as string;
    const { reason } = req.body as TerminateContractRequest;

    const terminatedIds = await prisma.$transaction(
      async (tx) => {
        // 名義変更で前の持ち主になった人（role_end_date あり）の契約は対象にしない
        const contractPlots = await tx.contractPlot.findMany({
          where: {
            deleted_at: null,
            contract_status: ContractStatus.active,
            saleContractRoles: {
              some: {
                customer_id: customerId,
                role: ContractRole.contractor,
                deleted_at: null,
                role_end_date: null,
              },
            },
          },
        });

        if (contractPlots.length === 0) {
          throw new ValidationError('解約できる契約がありません');
        }

        const ids: string[] = [];
        for (const contractPlot of contractPlots) {
          const beforeStatus = contractPlot.contract_status;
          contractStatusService.validateTransition(beforeStatus, ContractStatus.terminated);

          await tx.contractPlot.update({
            where: { id: contractPlot.id },
            data: { contract_status: ContractStatus.terminated },
          });

          await updatePhysicalPlotStatus(tx, contractPlot.physical_plot_id);

          await recordEntityUpdated(tx, {
            entityType: 'ContractPlot',
            entityId: contractPlot.id,
            physicalPlotId: contractPlot.physical_plot_id,
            contractPlotId: contractPlot.id,
            beforeRecord: { contract_status: beforeStatus },
            afterRecord: { contract_status: ContractStatus.terminated },
            changeReason: reason,
            req,
          });

          ids.push(contractPlot.id);
        }
        return ids;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    res.status(200).json({
      success: true,
      data: {
        message: `${terminatedIds.length}件の契約区画を解約しました`,
        customerId,
        terminatedIds,
      },
    });
  } catch (error) {
    next(error);
  }
};
