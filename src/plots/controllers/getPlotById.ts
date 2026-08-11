/**
 * 契約区画詳細取得コントローラー
 * GET /api/v1/plots/:id
 */

import { Request, Response, NextFunction } from 'express';
import { History } from '@prisma/client';
import prisma from '../../db/prisma';
import { NotFoundError } from '../../middleware/errorHandler';
import { formatHistoryWithLabels } from '../services/historyLabels';

/**
 * 契約区画詳細取得（ContractPlot中心）
 * GET /api/v1/plots/:id?includeHistory=true&historyLimit=50
 */
export const getPlotById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params as Record<string, string>;
    const includeHistory = req.query['includeHistory'] === 'true';
    const historyLimit = parseInt((req.query['historyLimit'] as string) || '50');

    const contractPlot = await prisma.contractPlot.findUnique({
      where: { id },
      include: {
        physicalPlot: true,
        buriedPersons: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' },
        },
        familyContacts: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' },
        },
        gravestoneInfo: true,
        constructionInfos: {
          where: { deleted_at: null },
          orderBy: { created_at: 'desc' },
        },
        collectiveBurial: true,
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

    if (!contractPlot || contractPlot.deleted_at) {
      throw new NotFoundError('契約区画が見つかりません');
    }

    // 履歴情報取得（オプション）
    // 当該契約区画に紐づく全エンティティの履歴を返す（issue #51）
    //
    // 注意: physical_plot_id は分割販売時に他の契約区画と共有されるため、
    // physical_plot_id で素朴に OR すると別契約の Customer / UsageFee 等の
    // 履歴まで漏れてしまう。PhysicalPlot 自体の履歴のみ physical_plot_id で
    // 拾い、それ以外は contract_plot_id 一致に絞る。
    let histories: History[] = [];
    if (includeHistory) {
      histories = await prisma.history.findMany({
        where: {
          OR: [
            { contract_plot_id: id },
            {
              entity_type: 'PhysicalPlot',
              physical_plot_id: contractPlot.physical_plot_id,
            },
          ],
        },
        orderBy: {
          created_at: 'desc',
        },
        take: historyLimit,
      });
    }

    // 主契約者（role='contractor'）を取得（後方互換性のため）
    const primaryRole = contractPlot.saleContractRoles?.find((role) => role.role === 'contractor');
    const primaryCustomer = primaryRole?.customer;

    const response = {
      // 契約区画基本情報
      id: contractPlot.id,
      contractAreaSqm: contractPlot.contract_area_sqm.toNumber(),
      locationDescription: contractPlot.location_description,
      createdAt: contractPlot.created_at,
      updatedAt: contractPlot.updated_at,

      // 物理区画情報
      physicalPlot: {
        id: contractPlot.physicalPlot.id,
        plotNumber: contractPlot.physicalPlot.plot_number,
        displayNumber: contractPlot.physicalPlot.display_number,
        areaName: contractPlot.physicalPlot.area_name,
        areaSqm: contractPlot.physicalPlot.area_sqm.toNumber(),
        status: contractPlot.physicalPlot.status,
        mapId: contractPlot.physicalPlot.map_id,
        notes: contractPlot.physicalPlot.notes,
      },

      // 販売契約情報（ContractPlotに統合済み）
      contractDate: contractPlot.contract_date,
      price: contractPlot.price,
      contractStatus: contractPlot.contract_status,
      paymentStatus: contractPlot.payment_status,
      reservationDate: contractPlot.reservation_date,
      requestDate: contractPlot.request_date,
      acceptanceNumber: contractPlot.acceptance_number,
      acceptanceDate: contractPlot.acceptance_date,
      staffInCharge: contractPlot.staff_in_charge,
      agentName: contractPlot.agent_name,
      permitDate: contractPlot.permit_date,
      permitNumber: contractPlot.permit_number,
      startDate: contractPlot.start_date,
      uncollectedAmount: contractPlot.uncollected_amount,
      contractNotes: contractPlot.notes,

      // レガシー由来の区分コード
      graveKind: contractPlot.grave_kind,
      graveKubun: contractPlot.grave_kubun,
      graveType: contractPlot.grave_type,
      legacyGraveCd: contractPlot.legacy_grave_cd,

      // 使用料情報
      usageFee: contractPlot.usageFee
        ? {
            calculationType: contractPlot.usageFee.calculation_type,
            taxType: contractPlot.usageFee.tax_type,
            billingType: contractPlot.usageFee.billing_type,
            billingYears: contractPlot.usageFee.billing_years,
            usageFee: contractPlot.usageFee.usage_fee,
            area: contractPlot.usageFee.area,
            unitPrice: contractPlot.usageFee.unit_price,
            paymentMethod: contractPlot.usageFee.payment_method,
          }
        : null,

      // 管理料情報
      managementFee: contractPlot.managementFee
        ? {
            calculationType: contractPlot.managementFee.calculation_type,
            taxType: contractPlot.managementFee.tax_type,
            billingType: contractPlot.managementFee.billing_type,
            billingYears: contractPlot.managementFee.billing_years,
            area: contractPlot.managementFee.area,
            billingMonth: contractPlot.managementFee.billing_month,
            managementFee: contractPlot.managementFee.management_fee,
            unitPrice: contractPlot.managementFee.unit_price,
            lastBillingMonth: contractPlot.managementFee.last_billing_month,
            paymentMethod: contractPlot.managementFee.payment_method,
          }
        : null,

      // 埋葬者情報
      buriedPersons: contractPlot.buriedPersons.map((person) => ({
        id: person.id,
        name: person.name,
        nameKana: person.name_kana,
        relationship: person.relationship,
        birthDate: person.birth_date,
        deathDate: person.death_date,
        age: person.age,
        gender: person.gender,
        burialDate: person.burial_date,
        posthumousName: person.posthumous_name,
        reportDate: person.report_date,
        religion: person.religion,
        deathPlace: person.death_place,
        causeOfDeath: person.cause_of_death,
        chiefMournerName: person.chief_mourner_name,
        chiefMournerRelationship: person.chief_mourner_relationship,
        validityPeriodYearsOverride: person.validity_period_years_override,
        isFinalBurial: person.is_final_burial,
        notes: person.notes,
      })),

      // 家族連絡先情報
      familyContacts: contractPlot.familyContacts.map((contact) => ({
        id: contact.id,
        name: contact.name,
        nameKana: contact.name_kana,
        birthDate: contact.birth_date,
        relationship: contact.relationship,
        postalCode: contact.postal_code,
        address: contact.address,
        phoneNumber: contact.phone_number,
        phoneNumber2: contact.phone_number_2,
        faxNumber: contact.fax_number,
        email: contact.email,
        registeredAddress: contact.registered_address,
        mailingType: contact.mailing_type,
        workCompanyName: contact.work_company_name,
        workCompanyNameKana: contact.work_company_name_kana,
        workAddress: contact.work_address,
        workPhoneNumber: contact.work_phone_number,
        contactMethod: contact.contact_method,
        notes: contact.notes,
      })),

      // 墓石情報
      gravestoneInfo: contractPlot.gravestoneInfo
        ? {
            gravestoneBase: contractPlot.gravestoneInfo.gravestone_base,
            enclosurePosition: contractPlot.gravestoneInfo.enclosure_position,
            gravestoneDealer: contractPlot.gravestoneInfo.gravestone_dealer,
            gravestoneType: contractPlot.gravestoneInfo.gravestone_type,
            surroundingArea: contractPlot.gravestoneInfo.surrounding_area,
            gravestoneCost: contractPlot.gravestoneInfo.gravestone_cost,
            gravestoneInscription: contractPlot.gravestoneInfo.gravestone_inscription,
            directionId: contractPlot.gravestoneInfo.direction_id,
            positionId: contractPlot.gravestoneInfo.position_id,
            establishmentDeadline: contractPlot.gravestoneInfo.establishment_deadline,
            establishmentDate: contractPlot.gravestoneInfo.establishment_date,
          }
        : null,

      // 工事情報
      constructionInfos: contractPlot.constructionInfos.map((construction) => ({
        id: construction.id,
        constructionType: construction.construction_type,
        startDate: construction.start_date,
        completionDate: construction.completion_date,
        contractor: construction.contractor,
        supervisor: construction.supervisor,
        progress: construction.progress,
        workItem1: construction.work_item_1,
        workDate1: construction.work_date_1,
        workAmount1: construction.work_amount_1 ? Number(construction.work_amount_1) : null,
        workStatus1: construction.work_status_1,
        workItem2: construction.work_item_2,
        workDate2: construction.work_date_2,
        workAmount2: construction.work_amount_2 ? Number(construction.work_amount_2) : null,
        workStatus2: construction.work_status_2,
        permitNumber: construction.permit_number,
        applicationDate: construction.application_date,
        permitDate: construction.permit_date,
        permitStatus: construction.permit_status,
        paymentType1: construction.payment_type_1,
        paymentAmount1: construction.payment_amount_1
          ? Number(construction.payment_amount_1)
          : null,
        paymentDate1: construction.payment_date_1,
        paymentStatus1: construction.payment_status_1,
        paymentType2: construction.payment_type_2,
        paymentAmount2: construction.payment_amount_2
          ? Number(construction.payment_amount_2)
          : null,
        paymentScheduledDate2: construction.payment_date_2,
        paymentStatus2: construction.payment_status_2,
        scheduledEndDate: construction.scheduled_end_date,
        constructionContent: construction.construction_content,
        constructionNotes: construction.notes,
      })),

      // 合祀情報
      collectiveBurial: contractPlot.collectiveBurial
        ? {
            id: contractPlot.collectiveBurial.id,
            burialCapacity: contractPlot.collectiveBurial.burial_capacity,
            currentBurialCount: contractPlot.collectiveBurial.current_burial_count,
            capacityReachedDate: contractPlot.collectiveBurial.capacity_reached_date,
            validityPeriodYears: contractPlot.collectiveBurial.validity_period_years,
            billingScheduledDate: contractPlot.collectiveBurial.billing_scheduled_date,
            billingStatus: contractPlot.collectiveBurial.billing_status,
            billingAmount: contractPlot.collectiveBurial.billing_amount
              ? Number(contractPlot.collectiveBurial.billing_amount)
              : null,
            notes: contractPlot.collectiveBurial.notes,
          }
        : null,

      // 履歴情報（日本語ラベル付与）
      histories: includeHistory ? histories.map(formatHistoryWithLabels) : undefined,

      // 後方互換性のため、主契約者の情報を設定
      primaryCustomer:
        primaryRole && primaryCustomer
          ? {
              id: primaryCustomer.id,
              name: primaryCustomer.name,
              nameKana: primaryCustomer.name_kana,
              gender: primaryCustomer.gender,
              birthDate: primaryCustomer.birth_date,
              phoneNumber: primaryCustomer.phone_number,
              faxNumber: primaryCustomer.fax_number,
              email: primaryCustomer.email,
              postalCode: primaryCustomer.postal_code,
              address: primaryCustomer.address,
              addressLine2: primaryCustomer.address_line_2,
              registeredAddress: primaryCustomer.registered_address,
              notes: primaryCustomer.notes,
              role: primaryRole.role,
              workInfo: primaryCustomer.workInfo
                ? {
                    companyName: primaryCustomer.workInfo.company_name,
                    companyNameKana: primaryCustomer.workInfo.company_name_kana,
                    workAddress: primaryCustomer.workInfo.work_address,
                    workPostalCode: primaryCustomer.workInfo.work_postal_code,
                    workPhoneNumber: primaryCustomer.workInfo.work_phone_number,
                    dmSetting: primaryCustomer.workInfo.dm_setting,
                    addressType: primaryCustomer.workInfo.address_type,
                    notes: primaryCustomer.workInfo.notes,
                  }
                : null,
            }
          : undefined,

      // 全ての役割と顧客情報
      roles:
        contractPlot.saleContractRoles?.map((role) => ({
          id: role.id,
          role: role.role,
          roleStartDate: role.role_start_date,
          roleEndDate: role.role_end_date,
          notes: role.notes,
          customer: {
            id: role.customer.id,
            name: role.customer.name,
            nameKana: role.customer.name_kana,
            gender: role.customer.gender,
            birthDate: role.customer.birth_date,
            phoneNumber: role.customer.phone_number,
            faxNumber: role.customer.fax_number,
            email: role.customer.email,
            postalCode: role.customer.postal_code,
            address: role.customer.address,
            addressLine2: role.customer.address_line_2,
            registeredPostalCode: role.customer.registered_postal_code,
            registeredAddress: role.customer.registered_address,
            // 振込先情報（ゆうちょ自動払込 CSV 出力用、レガシー t_danka.kikan_name 系から移行）
            bankName: role.customer.bank_name,
            branchName: role.customer.branch_name,
            accountType: role.customer.account_type,
            accountNumber: role.customer.account_number,
            accountHolder: role.customer.account_holder,
            yuchoSymbol: role.customer.yucho_symbol,
            yuchoNumber: role.customer.yucho_number,
            notes: role.customer.notes,
            workInfo: role.customer.workInfo
              ? {
                  companyName: role.customer.workInfo.company_name,
                  companyNameKana: role.customer.workInfo.company_name_kana,
                  workAddress: role.customer.workInfo.work_address,
                  workPostalCode: role.customer.workInfo.work_postal_code,
                  workPhoneNumber: role.customer.workInfo.work_phone_number,
                  dmSetting: role.customer.workInfo.dm_setting,
                  addressType: role.customer.workInfo.address_type,
                  notes: role.customer.workInfo.notes,
                }
              : null,
          },
        })) || [],
    };

    res.status(200).json({
      success: true,
      data: response,
    });
  } catch (error) {
    next(error);
  }
};
