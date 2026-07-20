import { z } from 'zod';
import { DmSetting, AddressType } from '@prisma/client';
import {
  applicantSchema as sharedApplicantSchema,
  customerSchema as sharedCustomerSchema,
  familyContactSchema as sharedFamilyContactSchema,
  buriedPersonSchema as sharedBuriedPersonSchema,
  gravestoneInfoSchema as sharedGravestoneInfoSchema,
  constructionInfoSchema as sharedConstructionInfoSchema,
  collectiveBurialSchema as sharedCollectiveBurialSchema,
  usageFeeSchema as sharedUsageFeeSchema,
  managementFeeSchema as sharedManagementFeeSchema,
  saleContractSchema as sharedSaleContractSchema,
  contractPlotSchema as sharedContractPlotSchema,
  physicalPlotSchema as sharedPhysicalPlotSchema,
} from '@komine/types';
import {
  uuidSchema,
  dateSchema,
  optionalDateSchema,
  phoneSchema,
  paginationSchema,
} from '../middleware/validation';

/**
 * Plot検索クエリのバリデーションスキーマ
 */
const graveClassificationParam = z
  .string()
  .optional()
  .transform((val) => {
    if (val === undefined || val === '') return undefined;
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? undefined : n;
  });

export const plotSearchQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  status: z.enum(['available', 'partially_sold', 'sold_out']).optional(), // PhysicalPlotStatus ENUM
  cemeteryType: z.string().optional(),
  paymentStatus: z
    .enum(['unpaid', 'partial_paid', 'paid', 'overdue', 'refunded', 'cancelled'])
    .optional(),
  // 契約ステータスフィルター（#200）。台帳問い合わせは vacant 非表示（#167）のため
  // active / terminated のみ許可する。vacant は在庫系エンドポイントで扱う。
  contractStatus: z.enum(['active', 'terminated']).optional(),
  sortBy: z
    .enum([
      'plotNumber',
      'customerName',
      'contractDate',
      'paymentStatus',
      'managementFee',
      'createdAt',
    ])
    .optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  nameKanaPrefix: z.string().max(5).optional(),
  graveKind: graveClassificationParam,
  graveKubun: graveClassificationParam,
  graveType: graveClassificationParam,
});

/**
 * Plot IDパラメータのバリデーションスキーマ
 */
export const plotIdParamsSchema = z.object({
  id: uuidSchema,
});

/**
 * 物理区画情報のバリデーションスキーマ（作成用）
 * 共有スキーマ（@komine/types/validations）をベースに、作成時のid任意付与に対応。
 */
const physicalPlotSchema = sharedPhysicalPlotSchema
  .extend({
    id: uuidSchema.optional(),
  })
  .partial({
    // 作成時は既存動作との互換性のためフィールドを任意化
    plotNumber: true,
    areaName: true,
    areaSqm: true,
  });

/**
 * 物理区画情報の更新バリデーションスキーマ
 * PUT /plots/:id の input.physicalPlot で利用
 * 全フィールドオプショナル（部分更新）
 */
const physicalPlotUpdateSchema = sharedPhysicalPlotSchema
  .extend({
    status: z.string().max(20).optional(),
  })
  .partial();

/**
 * 空き区画（物理区画のみ）先行登録のバリデーションスキーマ
 * POST /plots/physical（システム確認 項目⑦）
 * 契約者・契約情報なしで区画だけを登録する。区画番号・区画名は必須。
 */
export const createPhysicalPlotSchema = z.object({
  plotNumber: z
    .string()
    .min(1, '区画番号は必須です')
    .max(50, '区画番号は50文字以内で入力してください'),
  displayNumber: z.string().max(50).optional().nullable().or(z.literal('')),
  areaName: z
    .string()
    .min(1, '区画名（エリア）は必須です')
    .max(100, '区画名は100文字以内で入力してください'),
  areaSqm: z.coerce
    .number()
    .positive('面積は0より大きい値を入力してください')
    .lt(1000, '面積は1000㎡未満で入力してください')
    .optional(),
  mapId: z.coerce.number().int().optional().nullable(),
  notes: z.string().max(2000).optional().nullable().or(z.literal('')),
});

/**
 * 家族連絡先のバリデーションスキーマ
 * 共有スキーマをベースに、バックエンド固有フィールド（_delete, customerId, useWorkContact 等）を追加。
 * バルク登録でのスキップ判定（controller 側が必須フィールド欠落行をスキップ）と整合させるため、
 * 共有スキーマで必須になっている name / relationship / address / phoneNumber を任意化する。
 */
export const familyContactSchema = sharedFamilyContactSchema.extend({
  id: uuidSchema.optional(),
  _delete: z.boolean().optional(),
  customerId: uuidSchema.optional(),
  useWorkContact: z.boolean().optional(),
  workContactNotes: z.string().max(200).optional().or(z.literal('')),
  name: z.string().max(100).optional().or(z.literal('')),
  relationship: z.string().max(50).optional().or(z.literal('')),
  address: z.string().max(200).optional().or(z.literal('')),
  // 各上限は DB の VarChar 長に整合させる（#276）。共有スキーマの max(20)/max(10) の
  // ままだと Zod 通過後に Prisma P2000 → 500 となりトランザクション全体が失敗する。
  // phone_number/fax_number=VarChar(11), phone_number_2/work_phone_number=VarChar(15),
  // postal_code=VarChar(7)
  phoneNumber: z
    .string()
    .max(11, '電話番号は11文字以内（ハイフンなし）で入力してください')
    .optional()
    .or(z.literal('')),
  phoneNumber2: z.string().max(15).optional().nullable().or(z.literal('')),
  faxNumber: z
    .string()
    .max(11, 'FAX番号は11文字以内（ハイフンなし）で入力してください')
    .optional()
    .nullable()
    .or(z.literal('')),
  postalCode: z
    .string()
    .max(7, '郵便番号は7文字以内（ハイフンなし）で入力してください')
    .optional()
    .nullable()
    .or(z.literal('')),
  workPhoneNumber: z.string().max(15).optional().nullable().or(z.literal('')),
});

/**
 * 緊急連絡先のバリデーションスキーマ
 * 将来的に緊急連絡先管理エンドポイントで使用予定
 */
export const emergencyContactSchema = z
  .object({
    name: z.string().max(100).optional().or(z.literal('')),
    relationship: z.string().max(50).optional().or(z.literal('')),
    phoneNumber: phoneSchema,
  })
  .optional();

/**
 * 埋葬者情報のバリデーションスキーマ
 * 共有スキーマをベースに、バックエンド固有フィールド（_delete, graveNumber）を追加。
 * 共有スキーマで必須になっている name は、バルク登録でのスキップ判定のため任意化する。
 */
export const buriedPersonSchema = sharedBuriedPersonSchema.extend({
  id: uuidSchema.optional(),
  _delete: z.boolean().optional(),
  graveNumber: z.string().max(50).optional().or(z.literal('')),
  name: z.string().max(100).optional().or(z.literal('')),
});

/**
 * 墓石情報のバリデーションスキーマ
 * 共有スキーマをベースに、ルートが optional な APIペイロード形式に合わせる。
 */
export const gravestoneInfoSchema = sharedGravestoneInfoSchema.optional();

/**
 * 工事情報のバリデーションスキーマ
 * 共有スキーマをベースに、optional 配列要素として使用。
 */
export const constructionInfoSchema = sharedConstructionInfoSchema.optional();

/**
 * 工事情報の更新バリデーションスキーマ
 * PUT /plots/:id の input.constructionInfos[] で利用
 */
const constructionInfoUpdateSchema = sharedConstructionInfoSchema.extend({
  id: uuidSchema.optional(),
});

/**
 * 契約区画情報のバリデーションスキーマ
 * 共有スキーマをベース。
 */
const contractPlotSchema = sharedContractPlotSchema;

/**
 * 顧客役割情報における役割のバリデーションスキーマ
 */
const saleContractRoleSchema = z.object({
  customerId: uuidSchema.optional(), // 既存顧客を参照する場合（新規顧客の場合は不要）
  role: z.string().max(20, '役割は20文字以内で入力してください'), // applicant, contractor, heir, co_contractor など
  isPrimary: z.boolean().optional(), // 主たる役割かどうか
  roleStartDate: optionalDateSchema.nullable(),
  roleEndDate: optionalDateSchema.nullable(),
  notes: z.string().max(500).optional().or(z.literal('')),
});

/**
 * 販売契約情報のバリデーションスキーマ
 * 共有スキーマをベースに、バックエンド固有フィールド（customerRole, roles, uncollectedAmount）を追加。
 * paymentStatus は既存API互換性のため string を受け付ける（shared は nativeEnum）。
 */
const saleContractSchema = sharedSaleContractSchema.omit({ paymentStatus: true }).extend({
  paymentStatus: z.string().max(50).optional().or(z.literal('')),
  customerRole: z.string().max(50).optional().or(z.literal('')), // 後方互換性のため残す（deprecated）
  roles: z.array(saleContractRoleSchema).optional(), // 複数役割サポート（新方式）
  // @deprecated 手入力廃止（#170）。後方互換で受理するが controller で無視し、請求実績からの導出値で上書きされる。
  uncollectedAmount: z
    .number()
    .int()
    .nonnegative('未集金額は0以上の整数で入力してください')
    .optional(),
});

/**
 * 顧客情報のバリデーションスキーマ
 * 共有スキーマをベースに、バックエンド固有の要件（role は saleContract.roles で管理）に合わせる。
 */
// ゆうちょ記号(5桁)・番号は @komine/types 未追加のため backend ローカルで受理する（#170）。
// フロントのゆうちょ口座入力UI実装時に shared schema へ昇格予定。
// ゆうちょ番号は振替用7桁が正だが、申込書・通帳は末尾チェックデジット込みの8桁で
// 印字される。8桁許容で受理し、CSV 出力時に accountNumberFromYuchoNumber が
// 末尾CD除去で7桁化する（#170/#392）。9桁以上は不正値として弾く。
const customerSchema = sharedCustomerSchema.omit({ role: true }).extend({
  yuchoSymbol: z.string().max(5).optional().or(z.literal('')),
  yuchoNumber: z
    .string()
    .regex(/^\d{1,8}$/, 'ゆうちょ番号は8桁以内の数字で入力してください')
    .optional()
    .or(z.literal('')),
});

/**
 * controller の input.customer は @komine/types 由来の型でゆうちょ記号/番号を持たないため、
 * これらを読むときに使う補助型（#170）。runtime は customerSchema が受理済み。
 */
export type CustomerYuchoInput = {
  yuchoSymbol?: string | null;
  yuchoNumber?: string | null;
};

/**
 * Prisma enum 列向けバリデーション。
 * フロントは optional な enum 列を空文字 `''` で送ってくるため、`''` は undefined に正規化してから
 * nativeEnum で検査する。これにより enum に存在しない任意文字列（空文字含む）が素通りして
 * Prisma 実行時に enum 変換エラー（tx 全体ロールバックの 500）になるのを防ぐ（#393）。
 */
const optionalEnum = <T extends Record<string, string>>(enumObj: T) =>
  z.preprocess(
    (val) => (val === '' || val === null ? undefined : val),
    z.nativeEnum(enumObj).optional()
  );

/**
 * 勤務先情報のバリデーションスキーマ
 * （shared workInfoSchema と構造が異なるため独自定義）。
 * controller が読む全キーを受理する。最小サブセット時代は companyName/dmSetting 等が
 * ネストレベルで剥がされ、勤務先名称等の編集が静かに破棄されていた（#320）。
 * 各上限は DB の VarChar 長（company_name/company_name_kana=100, work_address=200,
 * work_postal_code=7）に整合。zodVarcharConsistency.test.ts で機械的に検証する。
 */
export const workInfoSchema = z
  .object({
    companyName: z
      .string()
      .max(100, '勤務先名称は100文字以内で入力してください')
      .optional()
      .or(z.literal('')),
    companyNameKana: z
      .string()
      .max(100, '勤務先名称カナは100文字以内で入力してください')
      .optional()
      .or(z.literal('')),
    // DB work_postal_code VarChar(7)（数字7桁保存確定 #338）。max(7) で P2000 を防ぐ（#395）。
    workPostalCode: z.string().max(7).optional().or(z.literal('')),
    workAddress: z.string().max(200).optional().or(z.literal('')),
    workPhoneNumber: phoneSchema,
    // DB は Prisma enum（DmSetting/AddressType）。任意文字列を弾く（#393）。
    dmSetting: optionalEnum(DmSetting),
    addressType: optionalEnum(AddressType),
    notes: z.string().max(1000).optional().or(z.literal('')),
  })
  .optional()
  .or(z.null());

/**
 * 請求情報のバリデーションスキーマ（ContractPlot用）
 */
const contractPlotBillingInfoSchema = z
  .object({
    billingType: z.string().max(50).optional().or(z.literal('')),
    accountType: z.string().max(50).optional().or(z.literal('')),
    bankName: z.string().max(100).optional().or(z.literal('')),
    branchName: z.string().max(100).optional().or(z.literal('')),
    accountNumber: z.string().max(20).optional().or(z.literal('')),
    accountHolder: z.string().max(100).optional().or(z.literal('')),
  })
  .optional()
  .or(z.null());

/**
 * 使用料情報のバリデーションスキーマ（ContractPlot用）
 * 共有スキーマをベースに、フロントが各フィールドを null/空文字として送信するケースを許容。
 */
const contractPlotUsageFeeSchema = sharedUsageFeeSchema.optional().or(z.null());

/**
 * 管理料情報のバリデーションスキーマ（ContractPlot用）
 * 共有スキーマをベースに、フロントが各フィールドを null/空文字として送信するケースを許容。
 */
const contractPlotManagementFeeSchema = sharedManagementFeeSchema.optional().or(z.null());

/**
 * 合祀設定のバリデーションスキーマ
 * 共有スキーマをベースに、ルート optional/null を許容。
 */
const collectiveBurialSchema = sharedCollectiveBurialSchema.optional().or(z.literal(null));

/**
 * ContractPlot作成リクエストのバリデーションスキーマ
 */
export const createPlotSchema = z.object({
  physicalPlot: physicalPlotSchema,
  contractPlot: contractPlotSchema,
  saleContract: saleContractSchema,
  customer: customerSchema,
  // 申込者（任意）。スキーマ欠落により validate() で剥がされ controller に届かなかった（#320）
  applicant: sharedApplicantSchema.optional(),
  workInfo: workInfoSchema,
  billingInfo: contractPlotBillingInfoSchema,
  usageFee: contractPlotUsageFeeSchema,
  managementFee: contractPlotManagementFeeSchema,
  // 墓石情報（任意）。スキーマ欠落により validate() で剥がされ controller に届かなかった（#320）
  gravestoneInfo: gravestoneInfoSchema,
  collectiveBurial: collectiveBurialSchema,
  familyContacts: z.array(familyContactSchema).optional(),
  // 埋葬者（任意）。スキーマ欠落により validate() で剥がされ、createPlot の保存処理
  // （createPlot.ts:375-424, PR#335）に届かず HTTP 経路で破棄されていた（#384, #320 同型）
  buriedPersons: z.array(buriedPersonSchema).optional(),
});

/**
 * ContractPlot更新リクエストのバリデーションスキーマ
 * すべてのフィールドがオプション
 */
export const updatePlotSchema = z.object({
  physicalPlot: physicalPlotUpdateSchema.optional(),
  contractPlot: contractPlotSchema.partial().optional(),
  saleContract: saleContractSchema.partial().optional(),
  customer: customerSchema.partial().optional(),
  // 申込者。undefined=変更なし / null=既存 applicant の解除 / object=upsert（既存は部分更新可）。
  // スキーマ欠落により validate() で剥がされ、申込者編集が静かに破棄されていた（#320）
  applicant: sharedApplicantSchema.partial().optional().or(z.null()),
  workInfo: workInfoSchema,
  billingInfo: contractPlotBillingInfoSchema,
  usageFee: contractPlotUsageFeeSchema,
  managementFee: contractPlotManagementFeeSchema,
  // 墓石情報。undefined=変更なし / null=削除 / object=upsert（#154 の更新永続化の受け口）。
  // スキーマ欠落により validate() で剥がされていた（#320）
  gravestoneInfo: gravestoneInfoSchema.or(z.null()),
  familyContacts: z.array(familyContactSchema).optional(),
  buriedPersons: z.array(buriedPersonSchema).optional(),
  constructionInfos: z.array(constructionInfoUpdateSchema).optional(),
  collectiveBurial: collectiveBurialSchema,
  // 変更理由（#261）。本更新で記録される履歴（History.change_reason VarChar(200)）に反映する
  changeReason: z.string().trim().max(200, '変更理由は200文字以内で入力してください').optional(),
});

/**
 * 物理区画に新規契約追加のバリデーションスキーマ
 * POST /plots/:id/contracts
 * physicalPlotセクションは不要（URLパラメータで指定されるため）
 */
export const createPlotContractSchema = z.object({
  contractPlot: contractPlotSchema,
  saleContract: saleContractSchema,
  customer: customerSchema,
  workInfo: workInfoSchema,
  billingInfo: contractPlotBillingInfoSchema,
  usageFee: contractPlotUsageFeeSchema,
  managementFee: contractPlotManagementFeeSchema,
});

/**
 * 契約復活リクエストのバリデーションスキーマ
 * POST /plots/:id/restore
 * terminated 状態の ContractPlot を active に戻す（誤操作リカバリ用）。
 * reason は履歴に記録するため必須（空白のみは拒否）。
 */
export const restoreContractSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, '復活理由は必須です')
    .max(200, '復活理由は200文字以内で入力してください'),
});

/**
 * 契約解約リクエストのバリデーションスキーマ（#236）
 * 解約理由は履歴に記録するため必須（restore と対称）
 */
export const terminateContractSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, '解約理由は必須です')
    .max(200, '解約理由は200文字以内で入力してください'),
});

/**
 * 名義変更リクエストのバリデーションスキーマ（#310）
 * POST /plots/:id/change-contractor
 * 新契約者は既存顧客の指定（newCustomerId）か新規顧客の作成（newCustomer）の
 * どちらか一方のみ。reason は任意（履歴の change_reason に「名義変更」へ付記）。
 */
export const changeContractorSchema = z
  .object({
    newCustomerId: uuidSchema.optional(),
    newCustomer: customerSchema.optional(),
    changeDate: optionalDateSchema.nullable(),
    reason: z.string().trim().max(200, '名義変更理由は200文字以内で入力してください').optional(),
  })
  .refine((v) => (v.newCustomerId !== undefined) !== (v.newCustomer !== undefined), {
    message:
      '新契約者は newCustomerId（既存顧客）または newCustomer（新規顧客）のどちらか一方を指定してください',
  });

/**
 * 型エクスポート
 */
export type PlotSearchQuery = z.infer<typeof plotSearchQuerySchema>;
export type PlotIdParams = z.infer<typeof plotIdParamsSchema>;
export type CreatePlotRequest = z.infer<typeof createPlotSchema>;
export type UpdatePlotRequest = z.infer<typeof updatePlotSchema>;
export type CreatePlotContractRequest = z.infer<typeof createPlotContractSchema>;
export type RestoreContractRequest = z.infer<typeof restoreContractSchema>;
export type TerminateContractRequest = z.infer<typeof terminateContractSchema>;
export type ChangeContractorRequest = z.infer<typeof changeContractorSchema>;

// dateSchema も従来通り再エクスポート（他モジュールからの参照互換性維持）
export { dateSchema };
