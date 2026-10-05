import { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: number;
        email: string;
        name: string;
        role: string;
        is_active: boolean;
        supabase_uid: string;
      };
    }
  }
}

const mockPrisma = {
  managementFee: { findMany: jest.fn() },
  collectiveBurial: { findMany: jest.fn() },
  billing: { findMany: jest.fn() },
};

jest.mock('../../src/db/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
  prisma: mockPrisma,
}));

import { getYuchoBilling, exportYuchoCsv } from '../../src/yucho/yuchoController';

const buildContractPlot = (overrides: Record<string, unknown> = {}) => ({
  id: 'cp-1',
  contract_date: new Date('2024-01-15'),
  payment_status: 'unpaid',
  contract_status: 'active',
  physicalPlot: {
    id: 'pp-1',
    plot_number: 'A-1',
    area_name: '第1期',
  },
  saleContractRoles: [
    {
      role: 'contractor',
      customer: {
        id: 'cust-1',
        name: '山田太郎',
        name_kana: 'ヤマダタロウ',
        bank_name: 'ゆうちょ銀行',
        branch_name: '〇一八',
        account_type: 'ordinary',
        account_number: '1234567',
        account_holder: 'ヤマダタロウ',
      },
    },
  ],
  ...overrides,
});

const buildResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  setHeader: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
});

const buildRequest = (query: Record<string, string>): Partial<Request> => ({
  query,
  params: {},
  body: {},
  user: {
    id: 1,
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin',
    is_active: true,
    supabase_uid: 'admin-uid',
  },
});

describe('yuchoController', () => {
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    res = buildResponse();
    next = jest.fn();
    mockPrisma.billing.findMany.mockResolvedValue([]);
  });

  describe('getYuchoBilling', () => {
    it('returns management fees only and does not bill collective burials', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'fee-1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '12000',
          contractPlot: buildContractPlot(),
        },
      ]);

      const req = buildRequest({ year: '2026', month: '4' });
      await getYuchoBilling(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(payload.data.period).toEqual({ year: 2026, month: 4 });
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0].category).toBe('management');
      expect(payload.data.summary.totalCount).toBe(1);
      expect(payload.data.summary.totalAmount).toBe(12000);
      expect(payload.data.summary.byCategory.management.amount).toBe(12000);
      expect(payload.data.summary.byCategory.collective.amount).toBe(0);
      expect(mockPrisma.collectiveBurial.findMany).not.toHaveBeenCalled();
      expect(payload.data.summary.exportableCount).toBe(1);
      expect(payload.data.summary.exportableAmount).toBe(12000);
      expect(payload.data.summary.excludedNoAccountCount).toBe(0);
    });

    it('口座未登録の請求は exportable から除外され excludedNoAccountCount に計上される (#172)', async () => {
      // 口座あり（出力対象）
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'fee-1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '12000',
          contractPlot: buildContractPlot(),
        },
        // 口座未登録（bank/branch/account がすべて null）→ 振替ファイルから無言除外される対象
        {
          id: 'fee-2',
          contract_plot_id: 'cp-3',
          billing_month: '4',
          management_fee: '8000',
          contractPlot: buildContractPlot({
            id: 'cp-3',
            physicalPlot: { id: 'pp-3', plot_number: 'C-3', area_name: '第1期' },
            saleContractRoles: [
              {
                role: 'contractor',
                customer: {
                  id: 'cust-3',
                  name: '佐藤花子',
                  name_kana: 'サトウハナコ',
                  bank_name: null,
                  branch_name: null,
                  account_type: null,
                  account_number: null,
                  account_holder: null,
                },
              },
            ],
          }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      // 一覧（totalCount）は除外前の全件
      expect(payload.data.summary.totalCount).toBe(2);
      expect(payload.data.summary.totalAmount).toBe(20000);
      // 実際にCSVへ出力されるのは口座ありの1件のみ
      expect(payload.data.summary.exportableCount).toBe(1);
      expect(payload.data.summary.exportableAmount).toBe(12000);
      // 口座未登録の1件は除外として可視化
      expect(payload.data.summary.excludedNoAccountCount).toBe(1);
    });

    it('filters out management fees whose billing_month does not match', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '10000',
          contractPlot: buildContractPlot(),
        },
        {
          id: 'f2',
          contract_plot_id: 'cp-2',
          billing_month: '5',
          management_fee: '8000',
          contractPlot: buildContractPlot({ id: 'cp-2' }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items).toHaveLength(1);
      expect(payload.data.items[0].sourceId).toBe('f1');
    });

    it('skips management fees with non-positive amounts', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '0',
          contractPlot: buildContractPlot(),
        },
        {
          id: 'f2',
          contract_plot_id: 'cp-2',
          billing_month: '4',
          management_fee: '',
          contractPlot: buildContractPlot({ id: 'cp-2' }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items).toHaveLength(0);
    });

    it('管理料の金額パースで負額・小数丸めを発生させない (#212)', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '-', // 未設定の意味のハイフン → 0 として除外
          contractPlot: buildContractPlot(),
        },
        {
          id: 'f2',
          contract_plot_id: 'cp-2',
          billing_month: '4',
          management_fee: '-1000', // 負号混入 → 負額にしない
          contractPlot: buildContractPlot({ id: 'cp-2' }),
        },
        {
          id: 'f3',
          contract_plot_id: 'cp-3',
          billing_month: '4',
          management_fee: '10,000円', // 正常系の表記ゆれ
          contractPlot: buildContractPlot({ id: 'cp-3' }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      const amounts = payload.data.items.map(
        (i: { sourceId: string; billingAmount: number }) => i.billingAmount
      );
      // 負の金額は一切含まれない
      expect(amounts.every((a: number) => a > 0)).toBe(true);
      // '10,000円' は 10000 として正常にパースされる
      const f3 = payload.data.items.find((i: { sourceId: string }) => i.sourceId === 'f3');
      expect(f3.billingAmount).toBe(10000);
      // '-' は除外される
      expect(
        payload.data.items.find((i: { sourceId: string }) => i.sourceId === 'f1')
      ).toBeUndefined();
    });

    it('管理料の金額パースで小数の桁結合・全角数字の0円化を発生させない (#275/#279)', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '3.6', // 小数表記 → '36'(10倍) に桁結合せず整数部 3 を採用
          contractPlot: buildContractPlot(),
        },
        {
          id: 'f2',
          contract_plot_id: 'cp-2',
          billing_month: '4',
          management_fee: '１２０００', // 全角数字 → 0円扱いで除外せず 12000 として処理
          contractPlot: buildContractPlot({ id: 'cp-2' }),
        },
        {
          id: 'f3',
          contract_plot_id: 'cp-3',
          billing_month: '4',
          management_fee: '12,000.50円', // 複合: 全角混在なし・カンマ円・小数 → 12000
          contractPlot: buildContractPlot({ id: 'cp-3' }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      const byId = (id: string) =>
        payload.data.items.find((i: { sourceId: string }) => i.sourceId === id);
      // '3.6' は 36 にならず整数部 3（warn ログ対象）
      expect(byId('f1').billingAmount).toBe(3);
      // 全角 '１２０００' は除外されず 12000
      expect(byId('f2').billingAmount).toBe(12000);
      // '12,000.50円' は 12000
      expect(byId('f3').billingAmount).toBe(12000);
    });

    it('returns no items for category=collective because collective burial has no fee', async () => {
      const req = buildRequest({ year: '2026', category: 'collective' });
      await getYuchoBilling(req as Request, res as Response, next);

      expect(mockPrisma.managementFee.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.collectiveBurial.findMany).not.toHaveBeenCalled();
      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items).toHaveLength(0);
      expect(payload.data.summary.totalAmount).toBe(0);
    });

    it('returns 400-style ValidationError for invalid year', async () => {
      const req = buildRequest({ year: 'abc' });
      await getYuchoBilling(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ name: 'ValidationError' }));
    });

    it('prefers contractor role over applicant when picking the payer', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '10000',
          contractPlot: buildContractPlot({
            saleContractRoles: [
              {
                role: 'applicant',
                customer: {
                  id: 'a1',
                  name: '申込太郎',
                  name_kana: 'モウシコミタロウ',
                  bank_name: '三菱UFJ銀行',
                  branch_name: '渋谷支店',
                  account_type: 'ordinary',
                  account_number: '7654321',
                  account_holder: 'モウシコミタロウ',
                },
              },
              {
                role: 'contractor',
                customer: {
                  id: 'c1',
                  name: '契約花子',
                  name_kana: 'ケイヤクハナコ',
                  bank_name: 'ゆうちょ銀行',
                  branch_name: '〇一八',
                  account_type: 'ordinary',
                  account_number: '1234567',
                  account_holder: 'ケイヤクハナコ',
                },
              },
            ],
          }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items[0].customerId).toBe('c1');
      expect(payload.data.items[0].billingInfo).toEqual({
        bankName: 'ゆうちょ銀行',
        branchName: '〇一八',
        accountType: 'ordinary',
        accountNumber: '1234567',
        accountHolder: 'ケイヤクハナコ',
      });
    });

    it('returns billingInfo=null when payer has no bank account fields', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '10000',
          contractPlot: buildContractPlot({
            saleContractRoles: [
              {
                role: 'contractor',
                customer: {
                  id: 'c1',
                  name: '契約花子',
                  name_kana: 'ケイヤクハナコ',
                  bank_name: null,
                  branch_name: null,
                  account_type: null,
                  account_number: null,
                  account_holder: null,
                },
              },
            ],
          }),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '4', category: 'management' });
      await getYuchoBilling(req as Request, res as Response, next);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.data.items[0].customerId).toBe('c1');
      expect(payload.data.items[0].billingInfo).toBeNull();
    });
  });

  describe('exportYuchoCsv', () => {
    const validQuery = {
      year: '2026',
      month: '4',
      kind: 'debit',
      transferDay: '15',
    };

    it('returns Shift-JIS debit CSV with 4 official columns', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '12000',
          contractPlot: buildContractPlot(),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest(validQuery);
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=Shift_JIS');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('yucho-debit-2026-all-')
      );
      expect(res.status).toHaveBeenCalledWith(200);
      const sent = (res.send as jest.Mock).mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(sent)).toBe(true);
      const iconv = (await import('iconv-lite')).default;
      const decoded = iconv.decode(sent, 'Shift_JIS');
      const lines = decoded.split('\r\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(1);
      expect(lines[0]!.split(',')).toHaveLength(4);
      expect(decoded.includes('cp-1')).toBe(false);
    });

    it('encodes Japanese kanji name in Shift-JIS for payer master', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([
        {
          id: 'f1',
          contract_plot_id: 'cp-1',
          billing_month: '4',
          management_fee: '12000',
          contractPlot: buildContractPlot(),
        },
      ]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest({
        year: '2026',
        month: '4',
        kind: 'payer_master',
      });
      await exportYuchoCsv(req as Request, res as Response, next);

      const sent = (res.send as jest.Mock).mock.calls[0][0] as Buffer;
      const iconv = (await import('iconv-lite')).default;
      expect(iconv.decode(sent, 'Shift_JIS').includes('山田太郎')).toBe(true);
    });

    it('uses official debit filename', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest(validQuery);
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('yucho-debit-2026-all-')
      );
    });

    it('sends empty buffer (no header row) when there are no billable items', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([]);
      mockPrisma.collectiveBurial.findMany.mockResolvedValue([]);

      const req = buildRequest(validQuery);
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const sent = (res.send as jest.Mock).mock.calls[0][0] as Buffer;
      expect(Buffer.isBuffer(sent)).toBe(true);
      expect(sent.length).toBe(0);
    });

    it('accepts any existing day as the debit transfer day', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([]);

      const req = buildRequest({ ...validQuery, transferDay: '17' });
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('rejects a day that does not exist in the month', async () => {
      const req = buildRequest({ year: '2026', month: '2', kind: 'debit', transferDay: '30' });
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'ValidationError', message: '2月30日はありません' })
      );
      expect(mockPrisma.managementFee.findMany).not.toHaveBeenCalled();
    });

    it('rejects a 120-character file on a day the bank is closed', async () => {
      // 2026-05-16 は土曜
      const req = buildRequest({
        year: '2026',
        month: '5',
        kind: 'zengin',
        transferMonth: '5',
        transferDay: '16',
      });
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ValidationError',
          message: '5月16日はゆうちょが休み（土日）なので引き落とせません',
        })
      );
    });

    it('does not block the debit CSV on a closed day because the date is not in the file', async () => {
      mockPrisma.managementFee.findMany.mockResolvedValue([]);

      const req = buildRequest({ year: '2026', month: '5', kind: 'debit', transferDay: '16' });
      await exportYuchoCsv(req as Request, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
