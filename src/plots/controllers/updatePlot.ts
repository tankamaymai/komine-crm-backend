/**
 * 契約区画更新エンドポイント
 * PUT /api/v1/plots/:id
 *
 * ContractPlot（販売契約情報統合済み）、Customer、関連情報の部分更新を行います。
 */

import { Request, Response, NextFunction } from 'express';
import { Prisma, ContractRole } from '@prisma/client';
import { UpdatePlotRequest } from '@komine/types';
import type { CustomerYuchoInput } from '../../validations/plotValidation';
import {
  updatePhysicalPlotStatus,
  buildGravestoneInfoData,
  syncPrimaryContractorNameKana,
  syncContractorNameKanaForCustomer,
} from '../utils';
import prisma from '../../db/prisma';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler';
import {
  recordContractPlotUpdated,
  recordCustomerCreated,
  recordCustomerUpdated,
  recordEntityCreated,
  recordEntityUpdated,
  recordEntityDeleted,
  recordHistoryBatch,
  type CreateHistoryInput,
} from '../services/historyService';
import {
  updateCollectiveBurialCount,
  resolveBillingScheduledDate,
} from '../../collective-burials/utils';
import { assertAssignableCustomer } from '../services/assertAssignableCustomer';

type Tx = Prisma.TransactionClient;

/**
 * 契約区画更新のトランザクション内処理
 * トランザクション境界の外から再利用できるよう外部化
 */
export async function updatePlotCore(
  tx: Tx,
  id: string,
  input: UpdatePlotRequest,
  req: Request
): Promise<void> {
  // 1. 既存のContractPlotを取得
  const existingContractPlot = await tx.contractPlot.findUnique({
    where: { id, deleted_at: null },
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
      collectiveBurial: true,
      gravestoneInfo: true,
    },
  });

  if (!existingContractPlot) {
    throw new NotFoundError('指定された契約区画が見つかりません');
  }

  const physicalPlotId = existingContractPlot.physical_plot_id;
  const oldContractArea = existingContractPlot.contract_area_sqm.toNumber();

  // 変更理由（#261）。指定があれば本更新で記録される全履歴エントリに反映する。
  const changeReason = input.changeReason;

  // 1.5. 物理区画情報の更新
  const physicalPlotInput = input.physicalPlot;
  if (physicalPlotInput) {
    const ppUpdateData: Record<string, unknown> = {};
    if (physicalPlotInput.plotNumber !== undefined)
      ppUpdateData['plot_number'] = physicalPlotInput.plotNumber;
    if (physicalPlotInput.areaName !== undefined)
      ppUpdateData['area_name'] = physicalPlotInput.areaName;
    if (physicalPlotInput.areaSqm !== undefined)
      ppUpdateData['area_sqm'] = new Prisma.Decimal(physicalPlotInput.areaSqm);
    if (physicalPlotInput.status !== undefined) ppUpdateData['status'] = physicalPlotInput.status;
    if (physicalPlotInput.notes !== undefined) ppUpdateData['notes'] = physicalPlotInput.notes;

    if (Object.keys(ppUpdateData).length > 0) {
      const beforePp = existingContractPlot.physicalPlot;
      const updatedPp = await tx.physicalPlot.update({
        where: { id: physicalPlotId },
        data: ppUpdateData,
      });
      await recordEntityUpdated(tx, {
        entityType: 'PhysicalPlot',
        entityId: physicalPlotId,
        physicalPlotId,
        beforeRecord: {
          plot_number: beforePp.plot_number,
          area_name: beforePp.area_name,
          area_sqm: beforePp.area_sqm.toString(),
          status: beforePp.status,
          notes: beforePp.notes,
        },
        afterRecord: {
          plot_number: updatedPp.plot_number,
          area_name: updatedPp.area_name,
          area_sqm: updatedPp.area_sqm.toString(),
          status: updatedPp.status,
          notes: updatedPp.notes,
        },
        changeReason,
        req,
      });
    }
  }

  // 2. ContractPlotの更新
  const updateData: Prisma.ContractPlotUpdateInput = {};

  if (input.contractPlot) {
    if (input.contractPlot.contractAreaSqm !== undefined) {
      const newAreaSqm = input.contractPlot.contractAreaSqm;

      const otherContracts = await tx.contractPlot.findMany({
        where: {
          physical_plot_id: physicalPlotId,
          id: { not: id },
          deleted_at: null,
        },
      });

      const otherContractsTotal = otherContracts.reduce(
        (sum, contract) => sum + contract.contract_area_sqm.toNumber(),
        0
      );

      const totalAfterUpdate = otherContractsTotal + newAreaSqm;
      const physicalPlotArea = existingContractPlot.physicalPlot.area_sqm.toNumber();

      if (totalAfterUpdate > physicalPlotArea) {
        throw new ValidationError(
          `契約面積の合計が物理区画の面積を超えています（物理区画: ${physicalPlotArea}㎡、合計: ${totalAfterUpdate}㎡）`
        );
      }

      updateData.contract_area_sqm = new Prisma.Decimal(newAreaSqm);
    }

    if (input.contractPlot.locationDescription !== undefined) {
      updateData.location_description = input.contractPlot.locationDescription;
    }

    if (input.contractPlot.inscription !== undefined) {
      updateData.inscription = input.contractPlot.inscription;
    }
  }

  if (input.saleContract) {
    if (input.saleContract.contractDate !== undefined) {
      updateData.contract_date = input.saleContract.contractDate
        ? new Date(input.saleContract.contractDate)
        : null;
    }
    if (input.saleContract.price !== undefined) {
      updateData.price = input.saleContract.price ?? null;
    }
    if (input.saleContract.paymentStatus !== undefined) {
      updateData.payment_status = input.saleContract.paymentStatus;
    }
    if (input.saleContract.reservationDate !== undefined) {
      updateData.reservation_date = input.saleContract.reservationDate
        ? new Date(input.saleContract.reservationDate)
        : null;
    }
    if (input.saleContract.acceptanceNumber !== undefined) {
      updateData.acceptance_number = input.saleContract.acceptanceNumber;
    }
    if (input.saleContract.acceptanceDate !== undefined) {
      updateData.acceptance_date = input.saleContract.acceptanceDate
        ? new Date(input.saleContract.acceptanceDate)
        : null;
    }
    if (input.saleContract.staffInCharge !== undefined) {
      updateData.staff_in_charge = input.saleContract.staffInCharge;
    }
    if (input.saleContract.agentName !== undefined) {
      updateData.agent_name = input.saleContract.agentName;
    }
    if (input.saleContract.permitNumber !== undefined) {
      updateData.permit_number = input.saleContract.permitNumber || null;
    }
    if (input.saleContract.permitDate !== undefined) {
      updateData.permit_date = input.saleContract.permitDate
        ? new Date(input.saleContract.permitDate)
        : null;
    }
    if (input.saleContract.startDate !== undefined) {
      updateData.start_date = input.saleContract.startDate
        ? new Date(input.saleContract.startDate)
        : null;
    }
    // 未収金額は請求実績から導出する派生値（#170）。手入力は無視し、請求/入金 CRUD と backfill で同期する。
    if (input.saleContract.notes !== undefined) {
      updateData.notes = input.saleContract.notes;
    }
  }

  // issue #66: update 戻り値を保持し section 13 で再取得しないようにする
  let updatedContractPlotRecord: Awaited<ReturnType<typeof tx.contractPlot.update>> | null = null;
  let updatedCustomerRecord: Awaited<ReturnType<typeof tx.customer.update>> | null = null;
  if (Object.keys(updateData).length > 0) {
    updatedContractPlotRecord = await tx.contractPlot.update({
      where: { id },
      data: updateData,
    });
  }

  // 3. 顧客役割の更新
  if (input.saleContract?.roles !== undefined) {
    // 申込者(applicant)ロールの正規管理経路はセクション6.5（input.applicant）。
    // roles 配列には通常 contractor 系しか含まれないため、applicant を含まない
    // roles を送られた場合に既存 applicant まで削除して消滅させない（#201）。
    // roles に applicant が明示的に含まれる場合のみ従来どおり全件入替の対象にする。
    const inputContainsApplicant = input.saleContract.roles.some(
      (roleData) => roleData.role === ContractRole.applicant
    );
    const roleScope = inputContainsApplicant ? {} : { role: { not: ContractRole.applicant } };

    const existingRoles = await tx.saleContractRole.findMany({
      where: {
        contract_plot_id: id,
        deleted_at: null,
        ...roleScope,
      },
    });

    await tx.saleContractRole.updateMany({
      where: {
        contract_plot_id: id,
        deleted_at: null,
        ...roleScope,
      },
      data: {
        deleted_at: new Date(),
      },
    });

    // バッチ用履歴エントリ（issue #66）
    const roleHistoryEntries: CreateHistoryInput[] = [];

    for (const oldRole of existingRoles) {
      roleHistoryEntries.push({
        entityType: 'SaleContractRole',
        entityId: oldRole.id,
        physicalPlotId,
        contractPlotId: id,
        actionType: 'DELETE',
        beforeRecord: {
          id: oldRole.id,
          role: oldRole.role,
          customer_id: oldRole.customer_id,
        },
        changeReason,
        req,
      });
    }

    for (const roleData of input.saleContract.roles) {
      if (!roleData.customerId) {
        throw new ValidationError('役割更新時は customerId が必須です');
      }
      // 解約者・論理削除顧客を契約者にできないようガード（changeContractor と同一不変条件・#394）
      await assertAssignableCustomer(tx, roleData.customerId);

      const created = await tx.saleContractRole.create({
        data: {
          contract_plot_id: existingContractPlot.id,
          customer_id: roleData.customerId,
          role: roleData.role,
          role_start_date: roleData.roleStartDate ? new Date(roleData.roleStartDate) : null,
          role_end_date: roleData.roleEndDate ? new Date(roleData.roleEndDate) : null,
          notes: roleData.notes || null,
        },
      });
      roleHistoryEntries.push({
        entityType: 'SaleContractRole',
        entityId: created.id,
        physicalPlotId,
        contractPlotId: id,
        actionType: 'CREATE',
        afterRecord: {
          id: created.id,
          role: created.role,
          customer_id: created.customer_id,
        },
        changeReason,
        req,
      });
    }

    await recordHistoryBatch(tx, roleHistoryEntries);
  }

  // 4. Customerの更新
  if (input.customer) {
    const primaryRole = existingContractPlot.saleContractRoles?.find(
      (role) => role.role === 'contractor'
    );
    const customerId = primaryRole?.customer.id;

    if (customerId) {
      const customerUpdateData: Prisma.CustomerUpdateInput = {};

      if (input.customer.name !== undefined) customerUpdateData.name = input.customer.name;
      if (input.customer.nameKana !== undefined)
        customerUpdateData.name_kana = input.customer.nameKana;
      if (input.customer.birthDate !== undefined) {
        customerUpdateData.birth_date = input.customer.birthDate
          ? new Date(input.customer.birthDate)
          : null;
      }
      if (input.customer.gender !== undefined) customerUpdateData.gender = input.customer.gender;
      if (input.customer.postalCode !== undefined)
        customerUpdateData.postal_code = input.customer.postalCode;
      if (input.customer.address !== undefined) customerUpdateData.address = input.customer.address;
      if (input.customer.addressLine2 !== undefined)
        customerUpdateData.address_line_2 = input.customer.addressLine2;
      if (input.customer.registeredPostalCode !== undefined)
        customerUpdateData.registered_postal_code = input.customer.registeredPostalCode;
      if (input.customer.registeredAddress !== undefined)
        customerUpdateData.registered_address = input.customer.registeredAddress;
      if (input.customer.phoneNumber !== undefined)
        customerUpdateData.phone_number = input.customer.phoneNumber;
      if (input.customer.faxNumber !== undefined)
        customerUpdateData.fax_number = input.customer.faxNumber;
      if (input.customer.email !== undefined) customerUpdateData.email = input.customer.email;
      // 振込先情報（ゆうちょ自動払込 CSV 出力用）
      if (input.customer.bankName !== undefined)
        customerUpdateData.bank_name = input.customer.bankName;
      if (input.customer.branchName !== undefined)
        customerUpdateData.branch_name = input.customer.branchName;
      if (input.customer.accountType !== undefined)
        customerUpdateData.account_type = input.customer.accountType;
      if (input.customer.accountNumber !== undefined)
        customerUpdateData.account_number = input.customer.accountNumber;
      if (input.customer.accountHolder !== undefined)
        customerUpdateData.account_holder = input.customer.accountHolder;
      const customerYucho = input.customer as unknown as CustomerYuchoInput;
      if (customerYucho.yuchoSymbol !== undefined)
        customerUpdateData.yucho_symbol = customerYucho.yuchoSymbol;
      if (customerYucho.yuchoNumber !== undefined)
        customerUpdateData.yucho_number = customerYucho.yuchoNumber;
      if (input.customer.notes !== undefined) customerUpdateData.notes = input.customer.notes;

      // issue #66: update 戻り値を保持し section 13 で再取得しないようにする
      if (Object.keys(customerUpdateData).length > 0) {
        updatedCustomerRecord = await tx.customer.update({
          where: { id: customerId },
          data: customerUpdateData,
        });
        // 共有契約者（レガシー移行で複数区画が同一 Customer を契約者として参照）の
        // 氏名・カナ変更は編集対象外の区画の snapshot も陳腐化させるため、
        // 顧客起点で該当する全契約区画を再同期する（#301）
        if (customerUpdateData.name !== undefined || customerUpdateData.name_kana !== undefined) {
          await syncContractorNameKanaForCustomer(tx, customerId);
        }
      }

      // 5. WorkInfoの更新/作成/削除
      if (input.workInfo !== undefined) {
        const existingWorkInfo = primaryRole?.customer.workInfo;

        if (input.workInfo === null) {
          if (existingWorkInfo) {
            await tx.workInfo.delete({
              where: { id: existingWorkInfo.id },
            });
            await recordEntityDeleted(tx, {
              entityType: 'WorkInfo',
              entityId: existingWorkInfo.id,
              physicalPlotId,
              contractPlotId: id,
              beforeRecord: {
                id: existingWorkInfo.id,
                company_name: existingWorkInfo.company_name,
                work_address: existingWorkInfo.work_address,
                work_phone_number: existingWorkInfo.work_phone_number,
              },
              changeReason,
              req,
            });
          }
        } else {
          const workInfoData: Partial<Prisma.WorkInfoUncheckedCreateInput> = {};
          if (input.workInfo.companyName !== undefined)
            workInfoData.company_name = input.workInfo.companyName;
          if (input.workInfo.companyNameKana !== undefined)
            workInfoData.company_name_kana = input.workInfo.companyNameKana;
          if (input.workInfo.workPostalCode !== undefined)
            workInfoData.work_postal_code = input.workInfo.workPostalCode;
          if (input.workInfo.workAddress !== undefined)
            workInfoData.work_address = input.workInfo.workAddress;
          if (input.workInfo.workPhoneNumber !== undefined)
            workInfoData.work_phone_number = input.workInfo.workPhoneNumber;
          if (input.workInfo.dmSetting !== undefined)
            workInfoData.dm_setting = input.workInfo.dmSetting;
          if (input.workInfo.addressType !== undefined)
            workInfoData.address_type = input.workInfo.addressType;
          if (input.workInfo.notes !== undefined) workInfoData.notes = input.workInfo.notes;

          if (Object.keys(workInfoData).length > 0) {
            if (existingWorkInfo) {
              const updated = await tx.workInfo.update({
                where: { id: existingWorkInfo.id },
                data: workInfoData,
              });
              await recordEntityUpdated(tx, {
                entityType: 'WorkInfo',
                entityId: existingWorkInfo.id,
                physicalPlotId,
                contractPlotId: id,
                beforeRecord: {
                  company_name: existingWorkInfo.company_name,
                  company_name_kana: existingWorkInfo.company_name_kana,
                  work_postal_code: existingWorkInfo.work_postal_code,
                  work_address: existingWorkInfo.work_address,
                  work_phone_number: existingWorkInfo.work_phone_number,
                  dm_setting: existingWorkInfo.dm_setting,
                  address_type: existingWorkInfo.address_type,
                  notes: existingWorkInfo.notes,
                },
                afterRecord: {
                  company_name: updated.company_name,
                  company_name_kana: updated.company_name_kana,
                  work_postal_code: updated.work_postal_code,
                  work_address: updated.work_address,
                  work_phone_number: updated.work_phone_number,
                  dm_setting: updated.dm_setting,
                  address_type: updated.address_type,
                  notes: updated.notes,
                },
                changeReason,
                req,
              });
            } else {
              const created = await tx.workInfo.create({
                // workInfoData は update/create 兼用の Partial。create が要求する必須スカラ
                // （company_name 等）は UpdatePlotRequest 側で任意のため型上は欠落しうるが、
                // 旧 any 実装と同じ実行時挙動を維持する。
                data: {
                  ...workInfoData,
                  customer_id: customerId,
                } as Prisma.WorkInfoUncheckedCreateInput,
              });
              await recordEntityCreated(tx, {
                entityType: 'WorkInfo',
                entityId: created.id,
                physicalPlotId,
                contractPlotId: id,
                afterRecord: {
                  id: created.id,
                  customer_id: customerId,
                  ...workInfoData,
                },
                changeReason,
                req,
              });
            }
          }
        }
      }

      // 6. BillingInfo は新スキーマで廃止された。
      // 振込先情報は今後 Billing/Payment エンティティから扱う予定（Phase 3で実装）。
    }
  }

  // 6.5. 申込者（applicant）の upsert / 解除
  // undefined: 変更なし / null: 既存の applicant role を soft-delete /
  // object: 既存あれば更新、なければ Customer + role を新規作成。
  if (input.applicant !== undefined) {
    const existingApplicantRole = existingContractPlot.saleContractRoles?.find(
      (r) => r.role === ContractRole.applicant
    );

    if (input.applicant === null) {
      if (existingApplicantRole) {
        await tx.saleContractRole.update({
          where: { id: existingApplicantRole.id },
          data: { deleted_at: new Date() },
        });
        await recordEntityDeleted(tx, {
          entityType: 'SaleContractRole',
          entityId: existingApplicantRole.id,
          physicalPlotId,
          contractPlotId: id,
          beforeRecord: {
            id: existingApplicantRole.id,
            role: existingApplicantRole.role,
            customer_id: existingApplicantRole.customer_id,
          },
          changeReason,
          req,
        });
      }
    } else if (existingApplicantRole) {
      // 既存の applicant Customer を部分更新
      const applicantCustomerId = existingApplicantRole.customer.id;
      const applicantUpdateData: Prisma.CustomerUpdateInput = {};
      if (input.applicant.name !== undefined) applicantUpdateData.name = input.applicant.name;
      if (input.applicant.nameKana !== undefined)
        applicantUpdateData.name_kana = input.applicant.nameKana;
      if (input.applicant.birthDate !== undefined) {
        applicantUpdateData.birth_date = input.applicant.birthDate
          ? new Date(input.applicant.birthDate)
          : null;
      }
      if (input.applicant.gender !== undefined) applicantUpdateData.gender = input.applicant.gender;
      if (input.applicant.postalCode !== undefined)
        applicantUpdateData.postal_code = input.applicant.postalCode ?? '';
      if (input.applicant.address !== undefined)
        applicantUpdateData.address = input.applicant.address ?? '';
      if (input.applicant.addressLine2 !== undefined)
        applicantUpdateData.address_line_2 = input.applicant.addressLine2;
      if (input.applicant.registeredPostalCode !== undefined)
        applicantUpdateData.registered_postal_code = input.applicant.registeredPostalCode;
      if (input.applicant.registeredAddress !== undefined)
        applicantUpdateData.registered_address = input.applicant.registeredAddress;
      if (input.applicant.phoneNumber !== undefined)
        applicantUpdateData.phone_number = input.applicant.phoneNumber;
      if (input.applicant.faxNumber !== undefined)
        applicantUpdateData.fax_number = input.applicant.faxNumber;
      if (input.applicant.email !== undefined) applicantUpdateData.email = input.applicant.email;
      if (input.applicant.notes !== undefined) applicantUpdateData.notes = input.applicant.notes;

      if (Object.keys(applicantUpdateData).length > 0) {
        const before = existingApplicantRole.customer;
        const updated = await tx.customer.update({
          where: { id: applicantCustomerId },
          data: applicantUpdateData,
        });
        await recordCustomerUpdated(
          tx,
          before as unknown as Record<string, unknown>,
          updated as unknown as Record<string, unknown>,
          applicantCustomerId,
          id,
          physicalPlotId,
          req,
          changeReason
        );
        // 申込者として編集した顧客が他区画の契約者を兼ねる場合（共有 Customer）も
        // snapshot が陳腐化するため、氏名・カナ変更時は顧客起点で再同期する（#301）
        if (applicantUpdateData.name !== undefined || applicantUpdateData.name_kana !== undefined) {
          await syncContractorNameKanaForCustomer(tx, applicantCustomerId);
        }
      }
    } else {
      // 新規 Customer + applicant role を作成
      if (!input.applicant.name || !input.applicant.nameKana) {
        throw new ValidationError('申込者の氏名・氏名カナは必須です');
      }
      const applicantCustomer = await tx.customer.create({
        data: {
          name: input.applicant.name,
          name_kana: input.applicant.nameKana,
          birth_date: input.applicant.birthDate ? new Date(input.applicant.birthDate) : null,
          gender: input.applicant.gender || null,
          postal_code: input.applicant.postalCode || '',
          address: input.applicant.address || '',
          address_line_2: input.applicant.addressLine2 || null,
          registered_postal_code: input.applicant.registeredPostalCode || null,
          registered_address: input.applicant.registeredAddress || null,
          phone_number: input.applicant.phoneNumber ?? null,
          fax_number: input.applicant.faxNumber || null,
          email: input.applicant.email || null,
          notes: input.applicant.notes || null,
          staff_id: input.applicant.staffId ?? null,
          legacy_danka_cd: input.applicant.legacyDankaCd ?? null,
        },
      });
      const createdRole = await tx.saleContractRole.create({
        data: {
          contract_plot_id: id,
          customer_id: applicantCustomer.id,
          role: ContractRole.applicant,
        },
      });
      await recordCustomerCreated(tx, applicantCustomer, id, physicalPlotId, req, changeReason);
      await recordEntityCreated(tx, {
        entityType: 'SaleContractRole',
        entityId: createdRole.id,
        physicalPlotId,
        contractPlotId: id,
        afterRecord: {
          id: createdRole.id,
          role: createdRole.role,
          customer_id: createdRole.customer_id,
        },
        changeReason,
        req,
      });
    }
  }

  // 7. UsageFee
  if (input.usageFee !== undefined) {
    if (input.usageFee === null) {
      if (existingContractPlot.usageFee) {
        const before = existingContractPlot.usageFee;
        await tx.usageFee.delete({
          where: { id: before.id },
        });
        await recordEntityDeleted(tx, {
          entityType: 'UsageFee',
          entityId: before.id,
          physicalPlotId,
          contractPlotId: id,
          beforeRecord: {
            id: before.id,
            calculation_type: before.calculation_type,
            tax_type: before.tax_type,
            usage_fee: before.usage_fee,
            area: before.area,
            unit_price: before.unit_price,
            payment_method: before.payment_method,
          },
          changeReason,
          req,
        });
      }
    } else {
      const usageFeeData: Partial<Prisma.UsageFeeUncheckedCreateInput> = {};
      if (input.usageFee.calculationType !== undefined)
        usageFeeData.calculation_type = input.usageFee.calculationType;
      if (input.usageFee.taxType !== undefined) usageFeeData.tax_type = input.usageFee.taxType;
      if (input.usageFee.usageFee !== undefined)
        usageFeeData.usage_fee = String(input.usageFee.usageFee ?? '');
      if (input.usageFee.area !== undefined) usageFeeData.area = String(input.usageFee.area ?? '');
      if (input.usageFee.unitPrice !== undefined)
        usageFeeData.unit_price = String(input.usageFee.unitPrice ?? '');
      if (input.usageFee.paymentMethod !== undefined)
        usageFeeData.payment_method = input.usageFee.paymentMethod;

      if (Object.keys(usageFeeData).length > 0) {
        if (existingContractPlot.usageFee) {
          const before = existingContractPlot.usageFee;
          const updated = await tx.usageFee.update({
            where: { id: before.id },
            data: usageFeeData,
          });
          await recordEntityUpdated(tx, {
            entityType: 'UsageFee',
            entityId: before.id,
            physicalPlotId,
            contractPlotId: id,
            beforeRecord: {
              calculation_type: before.calculation_type,
              tax_type: before.tax_type,
              usage_fee: before.usage_fee,
              area: before.area,
              unit_price: before.unit_price,
              payment_method: before.payment_method,
            },
            afterRecord: {
              calculation_type: updated.calculation_type,
              tax_type: updated.tax_type,
              usage_fee: updated.usage_fee,
              area: updated.area,
              unit_price: updated.unit_price,
              payment_method: updated.payment_method,
            },
            changeReason,
            req,
          });
        } else {
          const created = await tx.usageFee.create({
            data: {
              contract_plot_id: id,
              billing_type: '',
              billing_years: '1',
              ...usageFeeData,
            },
          });
          await recordEntityCreated(tx, {
            entityType: 'UsageFee',
            entityId: created.id,
            physicalPlotId,
            contractPlotId: id,
            afterRecord: {
              id: created.id,
              calculation_type: created.calculation_type,
              tax_type: created.tax_type,
              usage_fee: created.usage_fee,
              area: created.area,
              unit_price: created.unit_price,
              payment_method: created.payment_method,
            },
            changeReason,
            req,
          });
        }
      }
    }
  }

  // 8. ManagementFee
  if (input.managementFee !== undefined) {
    if (input.managementFee === null) {
      if (existingContractPlot.managementFee) {
        const before = existingContractPlot.managementFee;
        await tx.managementFee.delete({
          where: { id: before.id },
        });
        await recordEntityDeleted(tx, {
          entityType: 'ManagementFee',
          entityId: before.id,
          physicalPlotId,
          contractPlotId: id,
          beforeRecord: {
            id: before.id,
            management_fee: before.management_fee,
            billing_type: before.billing_type,
            billing_years: before.billing_years,
          },
          changeReason,
          req,
        });
      }
    } else {
      const managementFeeData: Partial<Prisma.ManagementFeeUncheckedCreateInput> = {};
      if (input.managementFee.calculationType !== undefined)
        managementFeeData.calculation_type = input.managementFee.calculationType;
      if (input.managementFee.taxType !== undefined)
        managementFeeData.tax_type = input.managementFee.taxType;
      if (input.managementFee.billingType !== undefined)
        managementFeeData.billing_type = input.managementFee.billingType;
      if (input.managementFee.billingYears !== undefined)
        managementFeeData.billing_years = String(input.managementFee.billingYears ?? '');
      if (input.managementFee.area !== undefined)
        managementFeeData.area = String(input.managementFee.area ?? '');
      if (input.managementFee.billingMonth !== undefined)
        managementFeeData.billing_month = input.managementFee.billingMonth;
      if (input.managementFee.managementFee !== undefined)
        managementFeeData.management_fee = String(input.managementFee.managementFee ?? '');
      if (input.managementFee.unitPrice !== undefined)
        managementFeeData.unit_price = String(input.managementFee.unitPrice ?? '');
      if (input.managementFee.lastBillingMonth !== undefined)
        managementFeeData.last_billing_month = input.managementFee.lastBillingMonth;
      if (input.managementFee.paymentMethod !== undefined)
        managementFeeData.payment_method = input.managementFee.paymentMethod;

      if (Object.keys(managementFeeData).length > 0) {
        if (existingContractPlot.managementFee) {
          const before = existingContractPlot.managementFee;
          const updated = await tx.managementFee.update({
            where: { id: before.id },
            data: managementFeeData,
          });
          await recordEntityUpdated(tx, {
            entityType: 'ManagementFee',
            entityId: before.id,
            physicalPlotId,
            contractPlotId: id,
            beforeRecord: {
              calculation_type: before.calculation_type,
              tax_type: before.tax_type,
              billing_type: before.billing_type,
              billing_years: before.billing_years,
              area: before.area,
              billing_month: before.billing_month,
              management_fee: before.management_fee,
              unit_price: before.unit_price,
              last_billing_month: before.last_billing_month,
              payment_method: before.payment_method,
            },
            afterRecord: {
              calculation_type: updated.calculation_type,
              tax_type: updated.tax_type,
              billing_type: updated.billing_type,
              billing_years: updated.billing_years,
              area: updated.area,
              billing_month: updated.billing_month,
              management_fee: updated.management_fee,
              unit_price: updated.unit_price,
              last_billing_month: updated.last_billing_month,
              payment_method: updated.payment_method,
            },
            changeReason,
            req,
          });
        } else {
          const created = await tx.managementFee.create({
            data: {
              contract_plot_id: id,
              ...managementFeeData,
            },
          });
          await recordEntityCreated(tx, {
            entityType: 'ManagementFee',
            entityId: created.id,
            physicalPlotId,
            contractPlotId: id,
            afterRecord: {
              id: created.id,
              ...managementFeeData,
            },
            changeReason,
            req,
          });
        }
      }
    }
  }

  // 8.5. GravestoneInfo（issue #154: update で永続化されていなかった）
  if (input.gravestoneInfo !== undefined) {
    const existingGravestone = existingContractPlot.gravestoneInfo;

    if (input.gravestoneInfo === null) {
      if (existingGravestone) {
        await tx.gravestoneInfo.delete({
          where: { id: existingGravestone.id },
        });
        await recordEntityDeleted(tx, {
          entityType: 'GravestoneInfo',
          entityId: existingGravestone.id,
          physicalPlotId,
          contractPlotId: id,
          beforeRecord: {
            id: existingGravestone.id,
            gravestone_base: existingGravestone.gravestone_base,
            gravestone_dealer: existingGravestone.gravestone_dealer,
            gravestone_type: existingGravestone.gravestone_type,
            direction_id: existingGravestone.direction_id,
            position_id: existingGravestone.position_id,
          },
          changeReason,
          req,
        });
      }
    } else {
      const gravestoneData = buildGravestoneInfoData(input.gravestoneInfo);

      if (Object.keys(gravestoneData).length > 0) {
        if (existingGravestone) {
          const before = existingGravestone;
          const updated = await tx.gravestoneInfo.update({
            where: { id: before.id },
            data: gravestoneData,
          });
          await recordEntityUpdated(tx, {
            entityType: 'GravestoneInfo',
            entityId: before.id,
            physicalPlotId,
            contractPlotId: id,
            beforeRecord: {
              gravestone_base: before.gravestone_base,
              enclosure_position: before.enclosure_position,
              gravestone_dealer: before.gravestone_dealer,
              gravestone_type: before.gravestone_type,
              surrounding_area: before.surrounding_area,
              gravestone_cost: before.gravestone_cost,
              establishment_deadline: before.establishment_deadline?.toISOString() ?? null,
              establishment_date: before.establishment_date?.toISOString() ?? null,
              gravestone_inscription: before.gravestone_inscription,
              direction_id: before.direction_id,
              position_id: before.position_id,
            },
            afterRecord: {
              gravestone_base: updated.gravestone_base,
              enclosure_position: updated.enclosure_position,
              gravestone_dealer: updated.gravestone_dealer,
              gravestone_type: updated.gravestone_type,
              surrounding_area: updated.surrounding_area,
              gravestone_cost: updated.gravestone_cost,
              establishment_deadline: updated.establishment_deadline?.toISOString() ?? null,
              establishment_date: updated.establishment_date?.toISOString() ?? null,
              gravestone_inscription: updated.gravestone_inscription,
              direction_id: updated.direction_id,
              position_id: updated.position_id,
            },
            changeReason,
            req,
          });
        } else {
          const created = await tx.gravestoneInfo.create({
            data: {
              contract_plot_id: id,
              ...gravestoneData,
            },
          });
          await recordEntityCreated(tx, {
            entityType: 'GravestoneInfo',
            entityId: created.id,
            physicalPlotId,
            contractPlotId: id,
            afterRecord: {
              id: created.id,
              gravestone_base: created.gravestone_base,
              gravestone_dealer: created.gravestone_dealer,
              gravestone_type: created.gravestone_type,
              direction_id: created.direction_id,
              position_id: created.position_id,
            },
            changeReason,
            req,
          });
        }
      }
    }
  }

  // 9. CollectiveBurial
  // 請求予定日（billing_scheduled_date）は契約日起点の導出値（#164）。
  // 契約日の変更・合祀情報の新規作成/復活・有効期間の変更で再計算する。
  // PUT /collective-burials/:id での手動指定（例外運用）は、これらが変わらない限り保持される。
  // 判定は「フィールドの存在」ではなく「実値の変化」で行う（#313: フォームは契約日を
  // 常時送信するため、存在判定だと保存のたびに手動例外がサイレント上書きされる）。
  let cbScheduleRecompute = false;
  if (input.saleContract?.contractDate !== undefined) {
    const inputContractDateMs = input.saleContract.contractDate
      ? new Date(input.saleContract.contractDate).getTime()
      : null;
    const existingContractDateMs = existingContractPlot.contract_date
      ? existingContractPlot.contract_date.getTime()
      : null;
    cbScheduleRecompute = inputContractDateMs !== existingContractDateMs;
  }
  if (input.collectiveBurial !== undefined) {
    const existingCB = existingContractPlot.collectiveBurial;

    if (input.collectiveBurial === null) {
      await tx.contractPlot.update({
        where: { id },
        data: {
          burial_capacity: null,
          validity_period_years: null,
        },
      });
      if (existingCB && !existingCB.deleted_at) {
        await tx.collectiveBurial.update({
          where: { id: existingCB.id },
          data: { deleted_at: new Date() },
        });
        await recordEntityDeleted(tx, {
          entityType: 'CollectiveBurial',
          entityId: existingCB.id,
          physicalPlotId,
          contractPlotId: id,
          beforeRecord: {
            id: existingCB.id,
            burial_capacity: existingCB.burial_capacity,
            validity_period_years: existingCB.validity_period_years,
            billing_amount: existingCB.billing_amount,
            notes: existingCB.notes,
          },
          changeReason,
          req,
        });
      }
    } else {
      await tx.contractPlot.update({
        where: { id },
        data: {
          burial_capacity: input.collectiveBurial.burialCapacity,
          validity_period_years: input.collectiveBurial.validityPeriodYears,
        },
      });

      if (existingCB && !existingCB.deleted_at) {
        if (
          input.collectiveBurial.validityPeriodYears !== undefined &&
          input.collectiveBurial.validityPeriodYears !== existingCB.validity_period_years
        ) {
          // 有効期間が変わった → 請求予定日を契約日起点で再計算（#164）
          cbScheduleRecompute = true;
        }
        const updated = await tx.collectiveBurial.update({
          where: { id: existingCB.id },
          data: {
            burial_capacity: input.collectiveBurial.burialCapacity,
            validity_period_years: input.collectiveBurial.validityPeriodYears,
            billing_amount: input.collectiveBurial.billingAmount ?? existingCB.billing_amount,
            notes:
              input.collectiveBurial.notes !== undefined
                ? input.collectiveBurial.notes || null
                : existingCB.notes,
          },
        });
        await recordEntityUpdated(tx, {
          entityType: 'CollectiveBurial',
          entityId: existingCB.id,
          physicalPlotId,
          contractPlotId: id,
          beforeRecord: {
            burial_capacity: existingCB.burial_capacity,
            validity_period_years: existingCB.validity_period_years,
            billing_amount: existingCB.billing_amount,
            notes: existingCB.notes,
          },
          afterRecord: {
            burial_capacity: updated.burial_capacity,
            validity_period_years: updated.validity_period_years,
            billing_amount: updated.billing_amount,
            notes: updated.notes,
          },
          changeReason,
          req,
        });
      } else {
        const cbCapacity = input.collectiveBurial.burialCapacity;
        const cbPeriod = input.collectiveBurial.validityPeriodYears;
        if (!cbCapacity || !cbPeriod) {
          throw new ValidationError(
            '新規合祀設定には burialCapacity と validityPeriodYears が必須です'
          );
        }

        // 新規作成・復活 → 請求予定日を契約日起点で導出（#164）
        cbScheduleRecompute = true;

        let cbCreated: { id: string };
        if (existingCB?.deleted_at) {
          cbCreated = await tx.collectiveBurial.update({
            where: { id: existingCB.id },
            data: {
              burial_capacity: cbCapacity,
              validity_period_years: cbPeriod,
              billing_amount: input.collectiveBurial.billingAmount ?? null,
              notes: input.collectiveBurial.notes || null,
              deleted_at: null,
            },
          });
        } else {
          cbCreated = await tx.collectiveBurial.create({
            data: {
              contract_plot_id: id,
              burial_capacity: cbCapacity,
              validity_period_years: cbPeriod,
              billing_amount: input.collectiveBurial.billingAmount ?? null,
              notes: input.collectiveBurial.notes || null,
            },
          });
        }
        await recordEntityCreated(tx, {
          entityType: 'CollectiveBurial',
          entityId: cbCreated.id,
          physicalPlotId,
          contractPlotId: id,
          afterRecord: {
            id: cbCreated.id,
            burial_capacity: cbCapacity,
            validity_period_years: cbPeriod,
            billing_amount: input.collectiveBurial.billingAmount ?? null,
            notes: input.collectiveBurial.notes || null,
          },
          changeReason,
          req,
        });
      }
    }
  }

  // 9.1. 請求予定日の再計算（#164: 契約日起点）
  // 契約日（step 2 適用後の値）＋有効期間から導出する。合祀情報の削除時は対象なし。
  if (cbScheduleRecompute) {
    const aliveCB = await tx.collectiveBurial.findUnique({
      where: { contract_plot_id: id },
    });
    if (aliveCB && !aliveCB.deleted_at) {
      const effectiveContractDate =
        updatedContractPlotRecord !== null
          ? updatedContractPlotRecord.contract_date
          : existingContractPlot.contract_date;
      await tx.collectiveBurial.update({
        where: { id: aliveCB.id },
        data: {
          billing_scheduled_date: resolveBillingScheduledDate(
            effectiveContractDate,
            aliveCB.validity_period_years
          ),
        },
      });
    }
  }

  // 9.5. 家族連絡先の全置換（issue #219: 送信されても保存されず無音破棄されるバグ修正）
  // 埋葬者(buriedPersons)と同じ id 突合方式で同期する。
  // 入力に id が存在しない既存レコードは soft-delete、id ありは update、id 無しは create。
  if (input.familyContacts !== undefined) {
    const existingFamilyContacts = await tx.familyContact.findMany({
      where: { contract_plot_id: id, deleted_at: null },
    });
    const existingFcIds = existingFamilyContacts.map((fc) => fc.id);
    const existingFcMap = new Map(existingFamilyContacts.map((fc) => [fc.id, fc]));
    const inputFcIds = input.familyContacts.filter((fc) => fc.id).map((fc) => fc.id as string);

    // バッチ用履歴エントリ（issue #66 と同様に末尾で一括 INSERT）
    const fcHistoryEntries: CreateHistoryInput[] = [];

    const fcIdsToDelete = existingFcIds.filter((eid) => !inputFcIds.includes(eid));
    if (fcIdsToDelete.length > 0) {
      await tx.familyContact.updateMany({
        where: { id: { in: fcIdsToDelete } },
        data: { deleted_at: new Date() },
      });
      for (const delId of fcIdsToDelete) {
        const before = existingFcMap.get(delId)!;
        fcHistoryEntries.push({
          entityType: 'FamilyContact',
          entityId: delId,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'DELETE',
          beforeRecord: {
            id: before.id,
            name: before.name,
            relationship: before.relationship,
            phone_number: before.phone_number,
          },
          changeReason,
          req,
        });
      }
    }

    for (const fc of input.familyContacts) {
      // 氏名・続柄は NOT NULL 制約。空行（フロントの空フォーム）はスキップして DB エラーを防ぐ。
      const fcName = fc.name?.trim();
      const fcRelationship = fc.relationship?.trim();
      if (!fcName || !fcRelationship) {
        continue;
      }

      const fcData = {
        emergency_contact_flag: fc.emergencyContactFlag ?? false,
        name: fcName,
        name_kana: fc.nameKana || null,
        birth_date: fc.birthDate ? new Date(fc.birthDate) : null,
        relationship: fcRelationship,
        postal_code: fc.postalCode || null,
        address: fc.address || null,
        phone_number: fc.phoneNumber || null,
        phone_number_2: fc.phoneNumber2 || null,
        fax_number: fc.faxNumber || null,
        email: fc.email || null,
        registered_address: fc.registeredAddress || null,
        mailing_type: fc.mailingType || null,
        work_company_name: fc.workCompanyName || null,
        work_company_name_kana: fc.workCompanyNameKana || null,
        work_address: fc.workAddress || null,
        work_phone_number: fc.workPhoneNumber || null,
        contact_method: fc.contactMethod || null,
        notes: fc.notes || null,
      };

      const serializeFc = (data: typeof fcData) => ({
        emergency_contact_flag: data.emergency_contact_flag,
        name: data.name,
        name_kana: data.name_kana,
        birth_date: data.birth_date?.toISOString() ?? null,
        relationship: data.relationship,
        postal_code: data.postal_code,
        address: data.address,
        phone_number: data.phone_number,
        phone_number_2: data.phone_number_2,
        fax_number: data.fax_number,
        email: data.email,
        registered_address: data.registered_address,
        mailing_type: data.mailing_type,
        work_company_name: data.work_company_name,
        work_company_name_kana: data.work_company_name_kana,
        work_address: data.work_address,
        work_phone_number: data.work_phone_number,
        contact_method: data.contact_method,
        notes: data.notes,
      });

      if (fc.id && existingFcIds.includes(fc.id)) {
        const before = existingFcMap.get(fc.id)!;
        await tx.familyContact.update({
          where: { id: fc.id },
          data: fcData,
        });
        fcHistoryEntries.push({
          entityType: 'FamilyContact',
          entityId: fc.id,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'UPDATE',
          beforeRecord: {
            emergency_contact_flag: before.emergency_contact_flag,
            name: before.name,
            name_kana: before.name_kana,
            birth_date: before.birth_date?.toISOString() ?? null,
            relationship: before.relationship,
            postal_code: before.postal_code,
            address: before.address,
            phone_number: before.phone_number,
            phone_number_2: before.phone_number_2,
            fax_number: before.fax_number,
            email: before.email,
            registered_address: before.registered_address,
            mailing_type: before.mailing_type,
            work_company_name: before.work_company_name,
            work_company_name_kana: before.work_company_name_kana,
            work_address: before.work_address,
            work_phone_number: before.work_phone_number,
            contact_method: before.contact_method,
            notes: before.notes,
          },
          afterRecord: serializeFc(fcData),
          changeReason,
          req,
        });
      } else {
        const created = await tx.familyContact.create({
          data: {
            contract_plot_id: id,
            ...fcData,
          },
        });
        fcHistoryEntries.push({
          entityType: 'FamilyContact',
          entityId: created.id,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'CREATE',
          afterRecord: { id: created.id, ...serializeFc(fcData) },
          changeReason,
          req,
        });
      }
    }

    // 履歴エントリをまとめて INSERT（issue #66）
    await recordHistoryBatch(tx, fcHistoryEntries);
  }

  // 10. 埋葬者の全置換
  if (input.buriedPersons !== undefined) {
    const existingBuriedPersons = await tx.buriedPerson.findMany({
      where: { contract_plot_id: id, deleted_at: null },
    });
    const existingIds = existingBuriedPersons.map((bp) => bp.id);
    const existingMap = new Map(existingBuriedPersons.map((bp) => [bp.id, bp]));
    const inputIds = input.buriedPersons.filter((bp) => bp.id).map((bp) => bp.id as string);

    // バッチ用履歴エントリ（このセクション終わりに createMany で一括 INSERT）
    const bpHistoryEntries: CreateHistoryInput[] = [];

    const idsToDelete = existingIds.filter((eid) => !inputIds.includes(eid));
    if (idsToDelete.length > 0) {
      await tx.buriedPerson.updateMany({
        where: { id: { in: idsToDelete } },
        data: { deleted_at: new Date() },
      });
      for (const delId of idsToDelete) {
        const before = existingMap.get(delId)!;
        bpHistoryEntries.push({
          entityType: 'BuriedPerson',
          entityId: delId,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'DELETE',
          beforeRecord: {
            id: before.id,
            name: before.name,
            death_date: before.death_date?.toISOString() ?? null,
            burial_date: before.burial_date?.toISOString() ?? null,
          },
          changeReason,
          req,
        });
      }
    }

    for (const bp of input.buriedPersons) {
      // 編集フォームがラウンドトリップしない4項目（死亡場所/死因/喪主名/喪主続柄）は、
      // 入力に存在する場合のみ書き込む。常に bp.xxx || null とすると、フォーム非対応の
      // これらが毎保存で undefined→null に潰れ、移行投入済み（step08-buried-person.ts）の
      // 値を破壊する（#383, critical）。undefined=変更なし / 値あり=更新 で部分更新化する。
      const formUnmanagedFields = {
        ...(bp.deathPlace !== undefined && { death_place: bp.deathPlace || null }),
        ...(bp.causeOfDeath !== undefined && { cause_of_death: bp.causeOfDeath || null }),
        ...(bp.chiefMournerName !== undefined && {
          chief_mourner_name: bp.chiefMournerName || null,
        }),
        ...(bp.chiefMournerRelationship !== undefined && {
          chief_mourner_relationship: bp.chiefMournerRelationship || null,
        }),
      };

      const bpData = {
        name: bp.name,
        name_kana: bp.nameKana || null,
        relationship: bp.relationship || null,
        birth_date: bp.birthDate ? new Date(bp.birthDate) : null,
        death_date: bp.deathDate ? new Date(bp.deathDate) : null,
        age: bp.age ?? null,
        gender: bp.gender || null,
        burial_date: bp.burialDate ? new Date(bp.burialDate) : null,
        posthumous_name: bp.posthumousName || null,
        report_date: bp.reportDate ? new Date(bp.reportDate) : null,
        religion: bp.religion || null,
        ...formUnmanagedFields,
        validity_period_years_override: bp.validityPeriodYearsOverride ?? null,
        notes: bp.notes || null,
      };

      const serialize = (data: typeof bpData) => ({
        name: data.name,
        name_kana: data.name_kana,
        relationship: data.relationship,
        birth_date: data.birth_date?.toISOString() ?? null,
        death_date: data.death_date?.toISOString() ?? null,
        age: data.age,
        gender: data.gender,
        burial_date: data.burial_date?.toISOString() ?? null,
        posthumous_name: data.posthumous_name,
        report_date: data.report_date?.toISOString() ?? null,
        religion: data.religion,
        death_place: data.death_place,
        cause_of_death: data.cause_of_death,
        chief_mourner_name: data.chief_mourner_name,
        chief_mourner_relationship: data.chief_mourner_relationship,
        validity_period_years_override: data.validity_period_years_override,
        notes: data.notes,
      });

      if (bp.id && existingIds.includes(bp.id)) {
        const before = existingMap.get(bp.id)!;
        await tx.buriedPerson.update({
          where: { id: bp.id },
          data: bpData,
        });
        bpHistoryEntries.push({
          entityType: 'BuriedPerson',
          entityId: bp.id,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'UPDATE',
          beforeRecord: {
            name: before.name,
            name_kana: before.name_kana,
            relationship: before.relationship,
            birth_date: before.birth_date?.toISOString() ?? null,
            death_date: before.death_date?.toISOString() ?? null,
            age: before.age,
            gender: before.gender,
            burial_date: before.burial_date?.toISOString() ?? null,
            posthumous_name: before.posthumous_name,
            report_date: before.report_date?.toISOString() ?? null,
            religion: before.religion,
            death_place: before.death_place,
            cause_of_death: before.cause_of_death,
            chief_mourner_name: before.chief_mourner_name,
            chief_mourner_relationship: before.chief_mourner_relationship,
            notes: before.notes,
          },
          afterRecord: serialize(bpData),
          changeReason,
          req,
        });
      } else {
        const created = await tx.buriedPerson.create({
          data: {
            contract_plot_id: id,
            ...bpData,
          },
        });
        bpHistoryEntries.push({
          entityType: 'BuriedPerson',
          entityId: created.id,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'CREATE',
          afterRecord: { id: created.id, ...serialize(bpData) },
          changeReason,
          req,
        });
      }
    }

    // 履歴エントリをまとめて INSERT（issue #66: N 件の個別 INSERT を 1 回に）
    await recordHistoryBatch(tx, bpHistoryEntries);

    const contractPlotForCB = await tx.contractPlot.findUnique({
      where: { id },
      select: { burial_capacity: true },
    });
    if (contractPlotForCB?.burial_capacity) {
      await updateCollectiveBurialCount(tx, id);
    }
  }

  // 11. 工事情報の全置換
  if (input.constructionInfos !== undefined) {
    const existingConstructionInfos = await tx.constructionInfo.findMany({
      where: { contract_plot_id: id, deleted_at: null },
    });
    const existingCiIds = existingConstructionInfos.map((ci) => ci.id);
    const existingCiMap = new Map(existingConstructionInfos.map((ci) => [ci.id, ci]));
    const inputCiIds = input.constructionInfos.filter((ci) => ci.id).map((ci) => ci.id as string);

    // バッチ用履歴エントリ（issue #66）
    const ciHistoryEntries: CreateHistoryInput[] = [];

    const ciIdsToDelete = existingCiIds.filter((eid) => !inputCiIds.includes(eid));
    if (ciIdsToDelete.length > 0) {
      await tx.constructionInfo.updateMany({
        where: { id: { in: ciIdsToDelete } },
        data: { deleted_at: new Date() },
      });
      for (const delId of ciIdsToDelete) {
        const before = existingCiMap.get(delId)!;
        ciHistoryEntries.push({
          entityType: 'ConstructionInfo',
          entityId: delId,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'DELETE',
          beforeRecord: {
            id: before.id,
            construction_type: before.construction_type,
            contractor: before.contractor,
            start_date: before.start_date?.toISOString() ?? null,
            completion_date: before.completion_date?.toISOString() ?? null,
          },
          changeReason,
          req,
        });
      }
    }

    for (const ci of input.constructionInfos) {
      const ciData = {
        construction_type: ci.constructionType || null,
        start_date: ci.startDate ? new Date(ci.startDate) : null,
        completion_date: ci.completionDate ? new Date(ci.completionDate) : null,
        contractor: ci.contractor || null,
        supervisor: ci.supervisor || null,
        progress: ci.progress || null,
        work_item_1: ci.workItem1 || null,
        work_date_1: ci.workDate1 ? new Date(ci.workDate1) : null,
        work_amount_1: ci.workAmount1 ?? null,
        work_status_1: ci.workStatus1 || null,
        work_item_2: ci.workItem2 || null,
        work_date_2: ci.workDate2 ? new Date(ci.workDate2) : null,
        work_amount_2: ci.workAmount2 ?? null,
        work_status_2: ci.workStatus2 || null,
        permit_number: ci.permitNumber || null,
        application_date: ci.applicationDate ? new Date(ci.applicationDate) : null,
        permit_date: ci.permitDate ? new Date(ci.permitDate) : null,
        permit_status: ci.permitStatus || null,
        payment_type_1: ci.paymentType1 || null,
        payment_amount_1: ci.paymentAmount1 ?? null,
        payment_date_1: ci.paymentDate1 ? new Date(ci.paymentDate1) : null,
        payment_status_1: ci.paymentStatus1 || null,
        payment_type_2: ci.paymentType2 || null,
        payment_amount_2: ci.paymentAmount2 ?? null,
        payment_date_2: ci.paymentScheduledDate2 ? new Date(ci.paymentScheduledDate2) : null,
        payment_status_2: ci.paymentStatus2 || null,
        scheduled_end_date: ci.scheduledEndDate ? new Date(ci.scheduledEndDate) : null,
        construction_content: ci.constructionContent || null,
        notes: ci.notes || null,
      };

      const serializeCi = (data: typeof ciData) => {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          result[k] = v instanceof Date ? v.toISOString() : v;
        }
        return result;
      };

      if (ci.id && existingCiIds.includes(ci.id)) {
        const before = existingCiMap.get(ci.id)!;
        await tx.constructionInfo.update({
          where: { id: ci.id },
          data: ciData,
        });
        const beforeSerialized: Record<string, unknown> = {};
        for (const key of Object.keys(ciData)) {
          const v = (before as Record<string, unknown>)[key];
          beforeSerialized[key] = v instanceof Date ? v.toISOString() : v;
        }
        ciHistoryEntries.push({
          entityType: 'ConstructionInfo',
          entityId: ci.id,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'UPDATE',
          beforeRecord: beforeSerialized,
          afterRecord: serializeCi(ciData),
          changeReason,
          req,
        });
      } else {
        const created = await tx.constructionInfo.create({
          data: {
            contract_plot_id: id,
            ...ciData,
          },
        });
        ciHistoryEntries.push({
          entityType: 'ConstructionInfo',
          entityId: created.id,
          physicalPlotId,
          contractPlotId: id,
          actionType: 'CREATE',
          afterRecord: { id: created.id, ...serializeCi(ciData) },
          changeReason,
          req,
        });
      }
    }

    // 履歴エントリをまとめて INSERT（issue #66）
    await recordHistoryBatch(tx, ciHistoryEntries);
  }

  // 12. 契約面積が変更された場合、物理区画のステータス更新
  if (
    input.contractPlot?.contractAreaSqm !== undefined &&
    input.contractPlot.contractAreaSqm !== oldContractArea
  ) {
    await updatePhysicalPlotStatus(tx, physicalPlotId);
  }

  // 13. 履歴の自動記録（ContractPlot、Customer）
  if (Object.keys(updateData).length > 0) {
    const beforeContractPlotData = {
      contract_area_sqm: existingContractPlot.contract_area_sqm.toString(),
      location_description: existingContractPlot.location_description,
      inscription: existingContractPlot.inscription,
      contract_date: existingContractPlot.contract_date?.toISOString(),
      price: existingContractPlot.price,
      payment_status: existingContractPlot.payment_status,
      reservation_date: existingContractPlot.reservation_date?.toISOString(),
      acceptance_number: existingContractPlot.acceptance_number,
      permit_date: existingContractPlot.permit_date?.toISOString(),
      start_date: existingContractPlot.start_date?.toISOString(),
      uncollected_amount: existingContractPlot.uncollected_amount,
      notes: existingContractPlot.notes,
    };

    // issue #66: section 2 の update 戻り値を再利用（findUnique 1 クエリ削減）
    const updatedCp = updatedContractPlotRecord;
    const afterContractPlotData = updatedCp
      ? {
          contract_area_sqm: updatedCp.contract_area_sqm.toString(),
          location_description: updatedCp.location_description,
          inscription: updatedCp.inscription,
          contract_date: updatedCp.contract_date?.toISOString(),
          price: updatedCp.price,
          payment_status: updatedCp.payment_status,
          reservation_date: updatedCp.reservation_date?.toISOString(),
          acceptance_number: updatedCp.acceptance_number,
          permit_date: updatedCp.permit_date?.toISOString(),
          start_date: updatedCp.start_date?.toISOString(),
          uncollected_amount: updatedCp.uncollected_amount,
          notes: updatedCp.notes,
        }
      : beforeContractPlotData;

    await recordContractPlotUpdated(
      tx,
      beforeContractPlotData,
      afterContractPlotData,
      physicalPlotId,
      id,
      req,
      changeReason
    );
  }

  if (input.customer) {
    const primaryRole = existingContractPlot.saleContractRoles?.find(
      (role) => role.role === 'contractor'
    );
    const existingCustomer = primaryRole?.customer;

    if (existingCustomer) {
      const beforeCustomerData = {
        name: existingCustomer.name,
        name_kana: existingCustomer.name_kana,
        birth_date: existingCustomer.birth_date?.toISOString(),
        gender: existingCustomer.gender,
        postal_code: existingCustomer.postal_code,
        address: existingCustomer.address,
        phone_number: existingCustomer.phone_number,
        email: existingCustomer.email,
      };

      // issue #66: section 4 の update 戻り値を再利用（findUnique 1 クエリ削減）
      const updatedCustomer = updatedCustomerRecord;
      const afterCustomerData = updatedCustomer
        ? {
            name: updatedCustomer.name,
            name_kana: updatedCustomer.name_kana,
            birth_date: updatedCustomer.birth_date?.toISOString(),
            gender: updatedCustomer.gender,
            postal_code: updatedCustomer.postal_code,
            address: updatedCustomer.address,
            phone_number: updatedCustomer.phone_number,
            email: updatedCustomer.email,
          }
        : beforeCustomerData;

      await recordCustomerUpdated(
        tx,
        beforeCustomerData,
        afterCustomerData,
        existingCustomer.id,
        id,
        physicalPlotId,
        req,
        changeReason
      );
    }
  }

  // 主契約者カナのスナップショット同期（#282）: ロール構成・顧客名の変更を反映する。
  // 契約者名ソート（sortBy=customerName）の DB 側ページングが参照する。
  await syncPrimaryContractorNameKana(tx, id);
}

/**
 * 契約区画更新
 * PUT /api/v1/plots/:id
 */
export const updatePlot = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const input = req.body as UpdatePlotRequest;

    // 履歴記録の createMany バッチ化・不要な findUnique 削減（issue #66）で
    // クエリ数は線形増加から定数的な増加に抑制。暫定 30 秒から 10 秒に短縮。
    await prisma.$transaction(
      async (tx) => {
        await updatePlotCore(tx, id as string, input, req);
      },
      {
        timeout: 10000,
        // 在庫面積・status再計算を含むため並行更新と直列化する（#278）
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }
    );

    // 更新後のデータを取得して返却
    const updatedContractPlot = await prisma.contractPlot.findUnique({
      where: { id },
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
        collectiveBurial: true,
      },
    });

    const primaryRole = updatedContractPlot?.saleContractRoles?.find(
      (role) => role.role === 'contractor'
    );
    const primaryCustomer = primaryRole?.customer;

    res.status(200).json({
      success: true,
      data: {
        id: updatedContractPlot?.id,
        contractAreaSqm: updatedContractPlot?.contract_area_sqm.toNumber(),
        locationDescription: updatedContractPlot?.location_description,

        contractDate: updatedContractPlot?.contract_date,
        price: updatedContractPlot?.price,
        paymentStatus: updatedContractPlot?.payment_status,
        reservationDate: updatedContractPlot?.reservation_date,
        acceptanceNumber: updatedContractPlot?.acceptance_number,
        permitDate: updatedContractPlot?.permit_date,
        permitNumber: updatedContractPlot?.permit_number,
        startDate: updatedContractPlot?.start_date,
        uncollectedAmount: updatedContractPlot?.uncollected_amount,
        notes: updatedContractPlot?.notes,

        physicalPlot: {
          id: updatedContractPlot?.physicalPlot.id,
          plotNumber: updatedContractPlot?.physicalPlot.plot_number,
          areaName: updatedContractPlot?.physicalPlot.area_name,
          areaSqm: updatedContractPlot?.physicalPlot.area_sqm.toNumber(),
          status: updatedContractPlot?.physicalPlot.status,
        },

        primaryCustomer: primaryCustomer
          ? {
              id: primaryCustomer.id,
              name: primaryCustomer.name,
              nameKana: primaryCustomer.name_kana,
              phoneNumber: primaryCustomer.phone_number,
              address: primaryCustomer.address,
              role: primaryRole?.role,
            }
          : null,

        roles:
          updatedContractPlot?.saleContractRoles?.map((role) => ({
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
          })) || [],

        collectiveBurial:
          updatedContractPlot?.collectiveBurial && !updatedContractPlot.collectiveBurial.deleted_at
            ? {
                id: updatedContractPlot.collectiveBurial.id,
                burialCapacity: updatedContractPlot.collectiveBurial.burial_capacity,
                currentBurialCount: updatedContractPlot.collectiveBurial.current_burial_count,
                capacityReachedDate: updatedContractPlot.collectiveBurial.capacity_reached_date,
                validityPeriodYears: updatedContractPlot.collectiveBurial.validity_period_years,
                billingScheduledDate: updatedContractPlot.collectiveBurial.billing_scheduled_date,
                billingStatus: updatedContractPlot.collectiveBurial.billing_status,
                billingAmount: updatedContractPlot.collectiveBurial.billing_amount,
                notes: updatedContractPlot.collectiveBurial.notes,
              }
            : null,

        updatedAt: updatedContractPlot?.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
};
