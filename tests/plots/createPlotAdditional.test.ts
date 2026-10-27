/**
 * まとめ買い登録: additionalPlots を含む POST /plots のテスト
 */
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

const mockPrisma: any = {
  physicalPlot: { findUnique: jest.fn(), create: jest.fn() },
  contractPlot: { findUnique: jest.fn(), create: jest.fn() },
  saleContractRole: { create: jest.fn() },
  customer: { create: jest.fn(), findUnique: jest.fn() },
  workInfo: { create: jest.fn() },
  usageFee: { create: jest.fn() },
  managementFee: { create: jest.fn() },
  gravestoneInfo: { create: jest.fn() },
  collectiveBurial: { create: jest.fn() },
  familyContact: { create: jest.fn() },
  buriedPerson: { create: jest.fn() },
  $transaction: jest.fn((callback: any) => Promise.resolve(callback(mockPrisma))),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  Prisma: {
    TransactionIsolationLevel: { Serializable: 'Serializable' },
    Decimal: class MockDecimal {
      constructor(private value: number) {}
      toNumber() {
        return this.value;
      }
      toString() {
        return String(this.value);
      }
    },
  },
  PaymentStatus: { unpaid: 'unpaid', partial: 'partial', paid: 'paid' },
  ContractStatus: { vacant: 'vacant', active: 'active', terminated: 'terminated' },
  ContractRole: { applicant: 'applicant', contractor: 'contractor' },
  DmSetting: { allow: 'allow' },
  AddressType: { home: 'home' },
}));

jest.mock('../../src/plots/utils', () => {
  const actual = jest.requireActual('../../src/plots/utils');
  return {
    validateContractArea: jest.fn(),
    updatePhysicalPlotStatus: jest.fn(),
    syncPrimaryContractorNameKana: jest.fn(),
    buildGravestoneInfoData: actual.buildGravestoneInfoData,
  };
});

jest.mock('../../src/plots/services/historyService', () => ({
  recordContractPlotCreated: jest.fn(),
  recordCustomerCreated: jest.fn(),
  recordEntityCreated: jest.fn(),
}));

import { createPlot } from '../../src/plots/controllers/createPlot';
import {
  validateContractArea,
  updatePhysicalPlotStatus,
  syncPrimaryContractorNameKana,
} from '../../src/plots/utils';
import { ValidationError } from '../../src/middleware/errorHandler';

const FIRST_PLOT_ID = 'pp-first';
const EXTRA_PLOT_ID = 'pp-extra';
const CUSTOMER_ID = 'c1';
const APPLICANT_ID = 'c-applicant';

function baseInput(): Record<string, any> {
  return {
    physicalPlot: { id: FIRST_PLOT_ID, plotNumber: '10', areaName: '一般墓地A' },
    contractPlot: { contractAreaSqm: 3.6 },
    saleContract: {
      contractDate: '2024-01-01',
      price: 1000000,
      staffInCharge: '担当太郎',
      permitNumber: 'P-1',
      notes: '1つ目だけのメモ',
    },
    customer: {
      name: '山田太郎',
      nameKana: 'ヤマダタロウ',
      postalCode: '1500001',
      address: '東京都渋谷区',
      phoneNumber: '0312345678',
    },
  };
}

function extraPlot(id = EXTRA_PLOT_ID, overrides: Record<string, unknown> = {}) {
  return {
    physicalPlot: { id, plotNumber: '11', areaName: '一般墓地A' },
    contractPlot: { contractAreaSqm: 1.8 },
    ...overrides,
  };
}

function mockPhysicalPlot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    plot_number: id === FIRST_PLOT_ID ? '10' : '11',
    display_number: id === FIRST_PLOT_ID ? '10' : '11',
    area_name: '一般墓地A',
    area_sqm: new Prisma.Decimal(3.6),
    status: 'available',
    deleted_at: null,
    ...overrides,
  };
}

function stubPhysicalPlots(extra: Record<string, unknown> = {}) {
  mockPrisma.physicalPlot.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
    if (where.id === FIRST_PLOT_ID) return Promise.resolve(mockPhysicalPlot(FIRST_PLOT_ID));
    if (where.id === EXTRA_PLOT_ID) return Promise.resolve(mockPhysicalPlot(EXTRA_PLOT_ID, extra));
    return Promise.resolve(null);
  });
}

describe('createPlot additionalPlots（まとめ買い登録）', () => {
  let res: Partial<Response>;
  let status: jest.Mock;
  let json: jest.Mock;
  let next: jest.Mock;
  let contractPlotSeq: number;
  let roleSeq: number;

  const run = (body: Record<string, any>) =>
    createPlot(
      { body, user: { id: 1, role: 'admin' } } as unknown as Request,
      res as Response,
      next
    );

  beforeEach(() => {
    jest.clearAllMocks();
    json = jest.fn().mockReturnThis();
    status = jest.fn().mockReturnThis();
    res = { status, json };
    next = jest.fn();
    contractPlotSeq = 0;
    roleSeq = 0;

    (validateContractArea as jest.Mock).mockResolvedValue({ isValid: true });
    (updatePhysicalPlotStatus as jest.Mock).mockResolvedValue(undefined);
    mockPrisma.$transaction.mockImplementation((callback: any) =>
      Promise.resolve(callback(mockPrisma))
    );
    mockPrisma.customer.create.mockImplementation(({ data }: { data: { name: string } }) =>
      Promise.resolve({ id: data.name === '申込花子' ? APPLICANT_ID : CUSTOMER_ID, ...data })
    );
    mockPrisma.contractPlot.create.mockImplementation(({ data }: { data: Record<string, any> }) =>
      Promise.resolve({ id: `cp-${++contractPlotSeq}`, ...data })
    );
    mockPrisma.saleContractRole.create.mockImplementation(
      ({ data }: { data: Record<string, any> }) =>
        Promise.resolve({ id: `scr-${++roleSeq}`, ...data })
    );
    mockPrisma.usageFee.create.mockResolvedValue({ id: 'uf-1' });
    mockPrisma.managementFee.create.mockResolvedValue({ id: 'mf-1' });
    mockPrisma.contractPlot.findUnique.mockResolvedValue({
      id: 'cp-1',
      contract_area_sqm: new Prisma.Decimal(3.6),
      physicalPlot: mockPhysicalPlot(FIRST_PLOT_ID),
      saleContractRoles: [],
    });
    stubPhysicalPlots();
  });

  it('additionalPlots が無ければ今までどおり1区画だけ作る', async () => {
    await run(baseInput());

    expect(mockPrisma.customer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contractPlot.create).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].data.additionalContractPlotIds).toEqual([]);
  });

  it('1区画足すと、お客様1人・契約2件・同じ人が両方の契約者になる', async () => {
    await run({ ...baseInput(), additionalPlots: [extraPlot()] });

    expect(next).not.toHaveBeenCalled();
    expect(mockPrisma.customer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contractPlot.create).toHaveBeenCalledTimes(2);
    const roles = mockPrisma.saleContractRole.create.mock.calls.map((c: any) => c[0].data);
    expect(roles).toEqual([
      expect.objectContaining({
        contract_plot_id: 'cp-1',
        customer_id: CUSTOMER_ID,
        role: 'contractor',
      }),
      expect.objectContaining({
        contract_plot_id: 'cp-2',
        customer_id: CUSTOMER_ID,
        role: 'contractor',
      }),
    ]);
    expect(updatePhysicalPlotStatus).toHaveBeenCalledWith(mockPrisma, EXTRA_PLOT_ID);
    expect(syncPrimaryContractorNameKana).toHaveBeenCalledWith(mockPrisma, 'cp-2');
    expect(status).toHaveBeenCalledWith(201);
    expect(json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ id: 'cp-1', additionalContractPlotIds: ['cp-2'] })
    );
  });

  it('2つ目は契約日・許可番号を1つ目から引き継ぎ、契約金額とメモは写さない', async () => {
    await run({ ...baseInput(), additionalPlots: [extraPlot()] });

    const second = mockPrisma.contractPlot.create.mock.calls[1][0].data;
    expect(second.contract_area_sqm.toNumber()).toBe(1.8);
    expect(second.contract_date).toEqual(new Date('2024-01-01'));
    expect(second.permit_number).toBe('P-1');
    expect(second.price).toBeNull();
    expect(second.notes).toBeNull();
  });

  it('2つ目に書いた契約金額・使用料・管理料は、その区画にだけ付く', async () => {
    await run({
      ...baseInput(),
      additionalPlots: [
        extraPlot(EXTRA_PLOT_ID, {
          saleContract: { price: 500000 },
          usageFee: { usageFee: '300000' },
          managementFee: { managementFee: '6000' },
        }),
      ],
    });

    expect(mockPrisma.contractPlot.create.mock.calls[1][0].data.price).toBe(500000);
    expect(mockPrisma.usageFee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contract_plot_id: 'cp-2', usage_fee: '300000' }),
    });
    expect(mockPrisma.managementFee.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ contract_plot_id: 'cp-2', management_fee: '6000' }),
    });
  });

  it('埋葬者は1つ目にだけ付く', async () => {
    mockPrisma.buriedPerson.create.mockResolvedValue({ id: 'bp-1', name: '山田一郎' });

    await run({
      ...baseInput(),
      buriedPersons: [{ name: '山田一郎' }],
      additionalPlots: [extraPlot()],
    });

    expect(mockPrisma.buriedPerson.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.buriedPerson.create.mock.calls[0][0].data.contract_plot_id).toBe('cp-1');
  });

  it('申込者がいれば、2つ目にも同じ申込者が付く', async () => {
    await run({
      ...baseInput(),
      applicant: { name: '申込花子', nameKana: 'モウシコミハナコ' },
      additionalPlots: [extraPlot()],
    });

    const roles = mockPrisma.saleContractRole.create.mock.calls.map((c: any) => c[0].data);
    expect(roles).toContainEqual(
      expect.objectContaining({
        contract_plot_id: 'cp-2',
        customer_id: APPLICANT_ID,
        role: 'applicant',
      })
    );
    expect(mockPrisma.customer.create).toHaveBeenCalledTimes(2);
  });

  it('1つ目と同じ区画を選ぶと止まる', async () => {
    await run({ ...baseInput(), additionalPlots: [extraPlot(FIRST_PLOT_ID)] });

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    expect(next.mock.calls[0][0].message).toBe('この区画はすでに選んでいます');
    expect(status).not.toHaveBeenCalledWith(201);
  });

  it('完売の区画は選べない', async () => {
    stubPhysicalPlots({ status: 'sold_out' });

    await run({ ...baseInput(), additionalPlots: [extraPlot()] });

    expect(next.mock.calls[0][0].message).toBe(
      '一般墓地Aの11番は完売しています。もう一度選び直してください'
    );
  });

  it('2つ目の残りが足りなければ、全部やめて1件も残さない', async () => {
    (validateContractArea as jest.Mock)
      .mockResolvedValueOnce({ isValid: true })
      .mockResolvedValueOnce({ isValid: false, message: '契約面積が足りません' });
    stubPhysicalPlots({ display_number: '12' });

    await run({ ...baseInput(), additionalPlots: [extraPlot()] });

    expect(next.mock.calls[0][0].message).toBe(
      '一般墓地Aの12番の残りが足りません。もう一度選び直してください'
    );
    await expect(mockPrisma.$transaction.mock.results[0].value).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(mockPrisma.contractPlot.findUnique).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith(201);
  });
});
