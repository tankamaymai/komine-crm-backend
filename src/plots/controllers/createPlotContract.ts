/**
 * 物理区画への契約追加エンドポイント
 * POST /api/v1/plots/:id/contracts
 *
 * 既存の物理区画に新規契約を追加します（分割販売対応）。
 */

import { Request, Response } from 'express';
import { Prisma, PaymentStatus, ContractRole, ContractStatus } from '@prisma/client';
import { CreatePlotRequest } from '@komine/types';
import {
  validateContractArea,
  updatePhysicalPlotStatus,
  buildGravestoneInfoData,
  syncPrimaryContractorNameKana,
} from '../utils';
import prisma from '../../db/prisma';
import { ValidationError } from '../../middleware/errorHandler';
import { allowDuplicateAcceptance, assertAcceptanceNumberAvailable } from '../services/acceptanceNumberCheck';
import { getRequestLogger } from '../../utils/logger';

/**
 * 物理区画に新規契約追加
 * POST /plots/:id/contracts
 */
export const createPlotContract = async (req: Request, res: Response): Promise<Response | void> => {
  try {
    const physicalPlotId = req.params['id'] as string;
    const input = req.body as CreatePlotRequest;

    // PhysicalPlotの存在確認
    const physicalPlot = await prisma.physicalPlot.findUnique({
      where: { id: physicalPlotId, deleted_at: null },
    });

    if (!physicalPlot) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: '指定された物理区画が見つかりません',
        },
      });
    }

    // トランザクション内で契約作成
    const result = await prisma.$transaction(
      async (tx) => {
        await assertAcceptanceNumberAvailable(
          tx,
          input.saleContract.acceptanceNumber,
          [],
          allowDuplicateAcceptance(input)
        );
        // 契約面積の検証（#278）: tx 外で検証すると検証〜作成の間に並行リクエストが
        // 同じ空き面積を見て両方通過し過剰割当が成立するため、tx 内で検証する。
        // Serializable 分離レベルにより同一物理区画への並行契約追加は直列化される。
        const validationResult = await validateContractArea(
          tx,
          physicalPlotId,
          input.contractPlot.contractAreaSqm
        );

        if (!validationResult.isValid) {
          throw new ValidationError(validationResult.message || '契約面積の検証に失敗しました');
        }

        // Customer作成
        const customer = await tx.customer.create({
          data: {
            name: input.customer.name,
            name_kana: input.customer.nameKana,
            birth_date: input.customer.birthDate ? new Date(input.customer.birthDate) : null,
            gender: input.customer.gender || null,
            postal_code: input.customer.postalCode,
            address: input.customer.address,
            registered_address: input.customer.registeredAddress || null,
            phone_number: input.customer.phoneNumber,
            fax_number: input.customer.faxNumber || null,
            email: input.customer.email || null,
            notes: input.customer.notes || null,
          },
        });

        // WorkInfo作成（オプション）
        if (input.workInfo) {
          await tx.workInfo.create({
            data: {
              customer_id: customer.id,
              company_name: input.workInfo.companyName || '',
              company_name_kana: input.workInfo.companyNameKana || '',
              work_postal_code: input.workInfo.workPostalCode || '',
              work_address: input.workInfo.workAddress || '',
              work_phone_number: input.workInfo.workPhoneNumber || '',
              dm_setting: input.workInfo.dmSetting || 'allow',
              address_type: input.workInfo.addressType || 'work',
              notes: input.workInfo.notes || null,
            },
          });
        }

        // ContractPlot作成（販売契約情報を統合）
        const contractPlot = await tx.contractPlot.create({
          data: {
            physical_plot_id: physicalPlotId,
            // 分割販売の新規契約も実契約のため active（schema default の vacant ではない）。#165 / #167 参照。
            contract_status: ContractStatus.active,
            contract_area_sqm: new Prisma.Decimal(input.contractPlot.contractAreaSqm),
            location_description: input.contractPlot.locationDescription || null,
            // 販売契約情報（ContractPlotに統合済み）
            contract_date: input.saleContract.contractDate
              ? new Date(input.saleContract.contractDate)
              : null,
            price: input.saleContract.price ?? null,
            payment_status: input.saleContract.paymentStatus || PaymentStatus.unpaid,
            reservation_date: input.saleContract.reservationDate
              ? new Date(input.saleContract.reservationDate)
              : null,
            request_date: input.saleContract.requestDate
              ? new Date(input.saleContract.requestDate)
              : null,
            acceptance_number: input.saleContract.acceptanceNumber || null,
            permit_number: input.saleContract.permitNumber || null,
            permit_date: input.saleContract.permitDate
              ? new Date(input.saleContract.permitDate)
              : null,
            start_date: input.saleContract.startDate
              ? new Date(input.saleContract.startDate)
              : null,
            // 未収金額は請求実績から導出する派生値（#170）。新規区画は請求未生成のため 0。手入力は無視。
            uncollected_amount: 0,
            notes: input.saleContract.notes || null,
            grave_kind: input.saleContract.graveKind ?? null,
            grave_kubun: input.saleContract.graveKubun ?? null,
            grave_type: input.saleContract.graveType ?? null,
            legacy_grave_cd: input.saleContract.legacyGraveCd ?? null,
          },
        });

        // 契約における顧客役割の作成
        // 新方式: roles配列が指定されている場合
        if (input.saleContract.roles && input.saleContract.roles.length > 0) {
          for (const roleData of input.saleContract.roles) {
            await tx.saleContractRole.create({
              data: {
                contract_plot_id: contractPlot.id, // sale_contract_id → contract_plot_idに変更
                customer_id: roleData.customerId || customer.id, // 指定がなければ作成した顧客を使用
                role: roleData.role,
                role_start_date: roleData.roleStartDate ? new Date(roleData.roleStartDate) : null,
                role_end_date: roleData.roleEndDate ? new Date(roleData.roleEndDate) : null,
                notes: roleData.notes || null,
              },
            });
          }
        } else {
          // 旧方式（後方互換性）: customerとcustomerRoleから1つの役割を作成
          await tx.saleContractRole.create({
            data: {
              contract_plot_id: contractPlot.id, // sale_contract_id → contract_plot_idに変更
              customer_id: customer.id,
              role: (input.saleContract.customerRole as ContractRole) || ContractRole.contractor,
            },
          });
        }

        // 墓石情報作成（オプション・issue #154）
        if (input.gravestoneInfo) {
          const gravestoneData = buildGravestoneInfoData(input.gravestoneInfo);
          if (Object.keys(gravestoneData).length > 0) {
            await tx.gravestoneInfo.create({
              data: {
                contract_plot_id: contractPlot.id,
                ...gravestoneData,
              },
            });
          }
        }

        // UsageFee作成（オプション）
        if (input.usageFee) {
          await tx.usageFee.create({
            data: {
              contract_plot_id: contractPlot.id,
              calculation_type: input.usageFee.calculationType || null,
              tax_type: input.usageFee.taxType || null,
              billing_type: input.usageFee.billingType || '',
              billing_years: input.usageFee.billingYears || '1',
              area: input.usageFee.area ? input.usageFee.area.toString() : null,
              unit_price: input.usageFee.unitPrice ? input.usageFee.unitPrice.toString() : null,
              usage_fee: input.usageFee.usageFee ? input.usageFee.usageFee.toString() : null,
              payment_method: input.usageFee.paymentMethod || null,
            },
          });
        }

        // ManagementFee作成（オプション）
        if (input.managementFee) {
          await tx.managementFee.create({
            data: {
              contract_plot_id: contractPlot.id,
              calculation_type: input.managementFee.calculationType || null,
              tax_type: input.managementFee.taxType || null,
              billing_type: input.managementFee.billingType || 'yearly',
              billing_years: input.managementFee.billingYears || '1',
              area: input.managementFee.area ? input.managementFee.area.toString() : null,
              billing_month: input.managementFee.billingMonth || null,
              management_fee: input.managementFee.managementFee
                ? input.managementFee.managementFee.toString()
                : null,
              unit_price: input.managementFee.unitPrice
                ? input.managementFee.unitPrice.toString()
                : null,
              last_billing_month: input.managementFee.lastBillingMonth || null,
              payment_method: input.managementFee.paymentMethod || null,
            },
          });
        }

        // PhysicalPlotのステータス更新
        await updatePhysicalPlotStatus(tx, physicalPlotId);

        // 主契約者カナのスナップショット同期（#282、契約者名ソートの DB 側ページング用）
        await syncPrimaryContractorNameKana(tx, contractPlot.id);

        return { contractPlot, customer };
      },
      // 在庫の検証・作成・status再計算を並行更新と直列化する（#278）
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    // 作成完了後、詳細情報を取得して返却
    const createdContractPlot = await prisma.contractPlot.findUnique({
      where: { id: result.contractPlot.id },
      include: {
        physicalPlot: true,
        saleContractRoles: {
          where: { deleted_at: null },
          include: {
            customer: {
              include: {
                workInfo: true,
              },
            },
          },
        },
        usageFee: true,
        managementFee: true,
      },
    });

    // 最初の役割を取得（後方互換性のため）
    const firstRole = createdContractPlot?.saleContractRoles?.[0];
    const firstCustomer = firstRole?.customer;

    res.status(201).json({
      success: true,
      data: {
        id: createdContractPlot?.id,
        contractAreaSqm: createdContractPlot?.contract_area_sqm.toNumber(),
        locationDescription: createdContractPlot?.location_description,

        // 販売契約情報（ContractPlotに統合済み）
        contractDate: createdContractPlot?.contract_date,
        price: createdContractPlot?.price,
        paymentStatus: createdContractPlot?.payment_status,
        reservationDate: createdContractPlot?.reservation_date,
        acceptanceNumber: createdContractPlot?.acceptance_number,
        permitDate: createdContractPlot?.permit_date,
        permitNumber: createdContractPlot?.permit_number,
        startDate: createdContractPlot?.start_date,
        notes: createdContractPlot?.notes,

        physicalPlot: {
          id: createdContractPlot?.physicalPlot.id,
          plotNumber: createdContractPlot?.physicalPlot.plot_number,
          areaName: createdContractPlot?.physicalPlot.area_name,
          areaSqm: createdContractPlot?.physicalPlot.area_sqm.toNumber(),
          status: createdContractPlot?.physicalPlot.status,
          mapId: createdContractPlot?.physicalPlot.map_id,
        },

        // 後方互換性: 最初の顧客の情報
        primaryCustomer: firstCustomer
          ? {
              id: firstCustomer.id,
              name: firstCustomer.name,
              nameKana: firstCustomer.name_kana,
              phoneNumber: firstCustomer.phone_number,
              address: firstCustomer.address,
              role: firstRole?.role,
            }
          : null,

        // 全ての役割と顧客情報
        roles: createdContractPlot?.saleContractRoles?.map((role) => ({
          id: role.id,
          role: role.role,
          roleStartDate: role.role_start_date,
          roleEndDate: role.role_end_date,
          notes: role.notes,
          customer: {
            id: role.customer.id,
            name: role.customer.name,
            nameKana: role.customer.name_kana,
            phoneNumber: role.customer.phone_number,
            address: role.customer.address,
          },
        })),

        createdAt: createdContractPlot?.created_at,
        updatedAt: createdContractPlot?.updated_at,
      },
    });
  } catch (error) {
    getRequestLogger().error({ err: error }, 'Error creating plot contract');

    // Serializable トランザクションの直列化競合（#278）。リトライで成功するため
    // 内部メッセージを晒す 400 でなく再試行を案内する 409 を返す。
    if ((error as { code?: string } | null)?.code === 'P2034') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'CONFLICT',
          message: '同時更新が競合しました。もう一度お試しください',
        },
      });
    }

    if (error instanceof Error && error.message) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '契約の作成に失敗しました',
      },
    });
  }
};
