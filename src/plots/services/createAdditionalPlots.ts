/**
 * まとめ買い登録の2つ目以降の区画作成
 * POST /plots の additionalPlots を、1つ目と同じ契約者で ContractPlot にする。
 * 埋葬者・墓石・家族連絡先などの付帯情報は1つ目にだけ付ける（仕様: COMBINED_PLOT_SALE_SPEC）。
 */

import { Request } from 'express';
import { Prisma, PaymentStatus, ContractRole, ContractStatus } from '@prisma/client';
import type { AdditionalPlotInput, CreatePlotRequest } from '@komine/types';
import {
  validateContractArea,
  updatePhysicalPlotStatus,
  syncPrimaryContractorNameKana,
} from '../utils';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler';
import { recordContractPlotCreated, recordEntityCreated } from './historyService';

const toDate = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

export async function createAdditionalPlotsForCustomer(
  tx: Prisma.TransactionClient,
  params: {
    customerId: string;
    applicantCustomerId: string | null;
    additionalPlots: AdditionalPlotInput[];
    sharedSaleContract: CreatePlotRequest['saleContract'];
    firstPhysicalPlotId: string;
    req: Request;
  }
): Promise<{ contractPlotIds: string[] }> {
  const {
    customerId,
    applicantCustomerId,
    additionalPlots,
    sharedSaleContract,
    firstPhysicalPlotId,
    req,
  } = params;

  const selectedPhysicalPlotIds = [
    firstPhysicalPlotId,
    ...additionalPlots.map((extra) => extra.physicalPlot.id),
  ];
  if (new Set(selectedPhysicalPlotIds).size !== selectedPhysicalPlotIds.length) {
    throw new ValidationError('この区画はすでに選んでいます');
  }

  const contractPlotIds: string[] = [];

  for (const extra of additionalPlots) {
    const physicalPlot = await tx.physicalPlot.findUnique({
      where: { id: extra.physicalPlot.id, deleted_at: null },
    });

    if (!physicalPlot) {
      throw new NotFoundError('指定された物理区画が見つかりません');
    }

    const plotLabel = `${physicalPlot.area_name}の${physicalPlot.display_number ?? physicalPlot.plot_number}番`;

    if (physicalPlot.status === 'sold_out') {
      throw new ValidationError(`${plotLabel}は完売しています。もう一度選び直してください`);
    }

    // 1つ目と同じく、保存のまとまりの中で残りの広さを確かめる（同時に売られるのを防ぐ）
    const validationResult = await validateContractArea(
      tx,
      physicalPlot.id,
      extra.contractPlot.contractAreaSqm
    );
    if (!validationResult.isValid) {
      throw new ValidationError(`${plotLabel}の残りが足りません。もう一度選び直してください`);
    }

    // 契約金額は区画ごと。1つ目の金額を写すと二重に数えるため、未指定なら空にする
    const contractPlot = await tx.contractPlot.create({
      data: {
        physical_plot_id: physicalPlot.id,
        contract_status: ContractStatus.active,
        contract_area_sqm: new Prisma.Decimal(extra.contractPlot.contractAreaSqm),
        location_description: extra.contractPlot.locationDescription || null,
        contract_date: toDate(sharedSaleContract.contractDate),
        price: extra.saleContract?.price ?? null,
        payment_status: sharedSaleContract.paymentStatus || PaymentStatus.unpaid,
        reservation_date: toDate(sharedSaleContract.reservationDate),
        request_date: toDate(sharedSaleContract.requestDate),
        acceptance_number: sharedSaleContract.acceptanceNumber || null,
        acceptance_date: toDate(sharedSaleContract.acceptanceDate),
        staff_in_charge: sharedSaleContract.staffInCharge || null,
        agent_name: sharedSaleContract.agentName || null,
        permit_number: sharedSaleContract.permitNumber || null,
        permit_date: toDate(sharedSaleContract.permitDate),
        start_date: toDate(sharedSaleContract.startDate),
        uncollected_amount: 0,
        notes: extra.saleContract?.notes || null,
        grave_kind: sharedSaleContract.graveKind ?? null,
        grave_kubun: sharedSaleContract.graveKubun ?? null,
        grave_type: sharedSaleContract.graveType ?? null,
        legacy_grave_cd: sharedSaleContract.legacyGraveCd ?? null,
      },
    });
    contractPlotIds.push(contractPlot.id);

    const roles: Array<{ customerId: string; role: ContractRole }> = [
      { customerId, role: ContractRole.contractor },
    ];
    if (applicantCustomerId) {
      roles.push({ customerId: applicantCustomerId, role: ContractRole.applicant });
    }
    const createdRoles = [];
    for (const role of roles) {
      createdRoles.push(
        await tx.saleContractRole.create({
          data: {
            contract_plot_id: contractPlot.id,
            customer_id: role.customerId,
            role: role.role,
          },
        })
      );
    }

    let usageFee: { id: string } | null = null;
    if (extra.usageFee) {
      usageFee = await tx.usageFee.create({
        data: {
          contract_plot_id: contractPlot.id,
          calculation_type: extra.usageFee.calculationType || '',
          tax_type: extra.usageFee.taxType || '',
          billing_type: extra.usageFee.billingType || '',
          billing_years: extra.usageFee.billingYears || '1',
          usage_fee: String(extra.usageFee.usageFee ?? ''),
          area: String(extra.usageFee.area ?? ''),
          unit_price: String(extra.usageFee.unitPrice ?? ''),
          payment_method: extra.usageFee.paymentMethod || '',
        },
      });
    }

    let managementFee: { id: string } | null = null;
    if (extra.managementFee) {
      managementFee = await tx.managementFee.create({
        data: {
          contract_plot_id: contractPlot.id,
          calculation_type: extra.managementFee.calculationType || '',
          tax_type: extra.managementFee.taxType || '',
          billing_type: extra.managementFee.billingType || '',
          billing_years: String(extra.managementFee.billingYears ?? ''),
          area: String(extra.managementFee.area ?? ''),
          billing_month: extra.managementFee.billingMonth || '',
          management_fee: String(extra.managementFee.managementFee ?? ''),
          unit_price: String(extra.managementFee.unitPrice ?? ''),
          last_billing_month: extra.managementFee.lastBillingMonth || '',
          payment_method: extra.managementFee.paymentMethod || '',
        },
      });
    }

    await updatePhysicalPlotStatus(tx, physicalPlot.id);
    await syncPrimaryContractorNameKana(tx, contractPlot.id);

    await recordContractPlotCreated(tx, contractPlot, req);
    for (const role of createdRoles) {
      await recordEntityCreated(tx, {
        entityType: 'SaleContractRole',
        entityId: role.id,
        physicalPlotId: physicalPlot.id,
        contractPlotId: contractPlot.id,
        afterRecord: { id: role.id, role: role.role, customer_id: role.customer_id },
        req,
      });
    }
    if (usageFee) {
      await recordEntityCreated(tx, {
        entityType: 'UsageFee',
        entityId: usageFee.id,
        physicalPlotId: physicalPlot.id,
        contractPlotId: contractPlot.id,
        afterRecord: { id: usageFee.id, ...extra.usageFee },
        req,
      });
    }
    if (managementFee) {
      await recordEntityCreated(tx, {
        entityType: 'ManagementFee',
        entityId: managementFee.id,
        physicalPlotId: physicalPlot.id,
        contractPlotId: contractPlot.id,
        afterRecord: { id: managementFee.id, ...extra.managementFee },
        req,
      });
    }
  }

  return { contractPlotIds };
}
