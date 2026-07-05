/**
 * 履歴フィールドの日本語ラベル定義
 *
 * 履歴テーブルの changed_fields に格納されるDB列名を、
 * UI表示用の日本語ラベルにマッピングする。
 *
 * issue #51 Phase 3: 履歴の表示改善
 * issue #69: フィールド名・値の日本語化・整形
 */

import { HistoryEntityType } from './historyService';

/**
 * 表示対象から除外するフィールド名
 *
 * - 主キー（id）
 * - タイムスタンプ系（created_at, updated_at, deleted_at）
 * - 外部キー（*_id）
 *
 * issue #69: システムフィールド・FK・UUIDを非表示にする
 */
export const HIDDEN_FIELDS: ReadonlySet<string> = new Set([
  // 主キー
  'id',
  // タイムスタンプ
  'created_at',
  'updated_at',
  'deleted_at',
  // 外部キー
  'physical_plot_id',
  'contract_plot_id',
  'sale_contract_id',
  'customer_id',
  'work_info_id',
  'billing_info_id',
  'usage_fee_id',
  'management_fee_id',
  'gravestone_info_id',
  'construction_info_id',
  'collective_burial_id',
  'buried_person_id',
  'family_contact_id',
  'document_id',
  // 名義変更履歴（changeContractor）が before/after に積む契約者の顧客UUID（#386）
  // ＝対の contractor_name / contractor_name_kana で人物は読めるため、UUID 露出は不要。
  'contractor_customer_id',
  // 移行履歴（t_dankalog/t_famlog）由来のレガシー surrogate key（#376）
  // ＝履歴は既にエンティティ単位にスコープ済みなので表示価値がなく、CREATE
  //   スナップショットでノイズになるため非表示にする。
  'danka_cd',
  'grave_cd',
  'family_cd',
]);

/**
 * フィールドを表示対象から除外すべきか判定する
 */
export function isHiddenField(fieldName: string): boolean {
  return HIDDEN_FIELDS.has(fieldName);
}

/**
 * エンティティ種別ごとのフィールド名→日本語ラベルマップ
 */
export const FIELD_LABELS: Record<HistoryEntityType, Record<string, string>> = {
  PhysicalPlot: {
    plot_number: '区画番号',
    area_name: '区画名',
    area_sqm: '面積(㎡)',
    status: 'ステータス',
    notes: '備考',
  },
  ContractPlot: {
    contract_area_sqm: '契約面積',
    location_description: '位置情報',
    contract_date: '契約日',
    price: '契約金額',
    payment_status: '支払ステータス',
    reservation_date: '予約日',
    acceptance_number: '受付番号',
    acceptance_date: '受付日',
    staff_in_charge: '担当者',
    agent_name: '取次者',
    permit_number: '許可番号',
    permit_date: '許可日',
    start_date: '開始日',
    uncollected_amount: '未収金額',
    burial_capacity: '埋葬可能数',
    validity_period_years: '有効期間（年）',
    // 名義変更履歴（changeContractor）が before/after に記録する契約者名（#386）
    contractor_name: '契約者名（名義変更）',
    contractor_name_kana: '契約者フリガナ（名義変更）',
    notes: '備考',
  },
  Customer: {
    name: '氏名',
    name_kana: 'フリガナ',
    birth_date: '生年月日',
    gender: '性別',
    postal_code: '郵便番号',
    address: '住所',
    address_line_2: '住所2',
    registered_address: '本籍地',
    phone_number: '電話番号',
    fax_number: 'FAX番号',
    email: 'メールアドレス',
    notes: '備考',
  },
  WorkInfo: {
    company_name: '勤務先名称',
    company_name_kana: '勤務先フリガナ',
    work_postal_code: '勤務先郵便番号',
    work_address: '勤務先住所',
    work_phone_number: '勤務先電話番号',
    dm_setting: 'DM設定',
    address_type: '送付先タイプ',
    notes: '備考',
  },
  BillingInfo: {
    billing_type: '支払方法',
    bank_name: '銀行名',
    branch_name: '支店名',
    account_type: '口座種別',
    account_number: '口座番号',
    account_holder: '口座名義',
  },
  UsageFee: {
    calculation_type: '計算方式',
    tax_type: '税区分',
    billing_type: '請求区分',
    billing_years: '請求年数',
    usage_fee: '使用料',
    area: '面積',
    unit_price: '単価',
    payment_method: '支払方法',
  },
  ManagementFee: {
    calculation_type: '計算方式',
    tax_type: '税区分',
    billing_type: '請求区分',
    billing_years: '請求年数',
    area: '面積',
    billing_month: '請求月',
    management_fee: '管理料',
    unit_price: '単価',
    last_billing_month: '最終請求月',
    payment_method: '支払方法',
  },
  BuriedPerson: {
    name: '氏名',
    name_kana: 'フリガナ',
    relationship: '続柄',
    birth_date: '生年月日',
    death_date: '死亡日',
    age: '享年',
    gender: '性別',
    burial_date: '埋葬日',
    posthumous_name: '戒名',
    report_date: '届出日',
    religion: '宗派',
    validity_period_years_override: '合祀年数（個別）',
    notes: '備考',
  },
  ConstructionInfo: {
    construction_type: '工事種別',
    start_date: '着工日',
    completion_date: '完工日',
    contractor: '施工業者',
    supervisor: '監督者',
    progress: '進捗',
    work_item_1: '作業項目1',
    work_date_1: '作業日1',
    work_amount_1: '作業金額1',
    work_status_1: '作業ステータス1',
    work_item_2: '作業項目2',
    work_date_2: '作業日2',
    work_amount_2: '作業金額2',
    work_status_2: '作業ステータス2',
    permit_number: '許可番号',
    application_date: '申請日',
    permit_date: '許可日',
    permit_status: '許可ステータス',
    payment_type_1: '支払種別1',
    payment_amount_1: '支払金額1',
    payment_date_1: '支払日1',
    payment_status_1: '支払ステータス1',
    payment_type_2: '支払種別2',
    payment_amount_2: '支払金額2',
    payment_date_2: '支払日2',
    payment_status_2: '支払ステータス2',
    scheduled_end_date: '完了予定日',
    construction_content: '工事内容',
    notes: '備考',
  },
  CollectiveBurial: {
    burial_capacity: '埋葬可能数',
    current_burial_count: '現在埋葬数',
    capacity_reached_date: '満員到達日',
    validity_period_years: '有効期間（年）',
    billing_scheduled_date: '請求予定日',
    billing_status: '請求ステータス',
    billing_amount: '請求金額',
    notes: '備考',
  },
  GravestoneInfo: {
    gravestone_base: '台石',
    enclosure_position: '囲い位置',
    gravestone_dealer: '石材店',
    gravestone_type: '墓石種類',
    surrounding_area: '周辺面積',
    gravestone_cost: '墓石費用',
    establishment_deadline: '建立期限',
    establishment_date: '建立日',
  },
  FamilyContact: {
    name: '氏名',
    name_kana: 'フリガナ',
    relationship: '続柄',
    emergency_contact_flag: '緊急連絡先フラグ',
    postal_code: '郵便番号',
    address: '住所',
    phone_number: '電話番号',
    phone_number_2: '電話番号2',
    fax_number: 'FAX番号',
    email: 'メールアドレス',
    notes: '備考',
  },
  SaleContractRole: {
    role: '役割',
    customer_id: '顧客ID',
    role_start_date: '役割開始日',
    role_end_date: '役割終了日',
    notes: '備考',
  },
  Document: {
    type: '書類種別',
    name: '書類名',
  },
  Billing: {
    category: '請求区分',
    use_start_year: '使用開始年',
    use_end_year: '使用終了年',
    target_month: '対象月',
    billing_years: '請求年数',
    amount: '請求金額',
    billing_date: '請求日',
    paid_amount: '入金済額',
    status: '請求ステータス',
    notes: '備考',
  },
  Payment: {
    scheduled_date: '入金予定日',
    scheduled_amount: '入金予定額',
    payment_date: '入金日',
    payment_amount: '入金額',
    fee_type: '料金種別',
    notes: '備考',
  },
};

/**
 * レガシーログ表（t_dankalog / t_famlog）の生カラム名 → 日本語ラベル（#376）
 *
 * 移行履歴（step14-history）は t_dankalog/t_famlog の生カラム名を changed_fields /
 * before_record / after_record のキーへそのまま格納するため、現行 Prisma 名ベースの
 * FIELD_LABELS では解決できず、getFieldLabel が物理名（owner_sei / zip / tel1 …）を
 * そのまま返していた。ここでレガシー列名のエイリアスを補い、本番 9290 件（#354）の
 * 移行履歴を無改修で可読化する。
 *
 * - アプリ内編集で新規記録される履歴は Prisma 名なので本マップは経由しない。
 * - before/after の生レガシー「値」整形は本マップの対象外（必要なら別 issue）。
 */

// t_dankalog / t_famlog 共通の住所・連絡先・勤務先・メモ列
const LEGACY_COMMON_LABELS: Record<string, string> = {
  sex_flg: '性別',
  birthday: '生年月日',
  honseki_zip: '本籍地郵便番号',
  honseki_addr1: '本籍地住所1',
  honseki_addr2: '本籍地住所2',
  zip: '郵便番号',
  addr1: '住所1',
  addr2: '住所2',
  addr3: '住所3',
  tel1: '電話番号1',
  tel2: '電話番号2',
  fax: 'FAX番号',
  email1: 'メールアドレス1',
  email2: 'メールアドレス2',
  magazin_flg: 'メルマガ配信フラグ',
  job_name: '勤務先名称',
  job_name_kana: '勤務先フリガナ',
  job_zip: '勤務先郵便番号',
  job_addr1: '勤務先住所1',
  job_addr2: '勤務先住所2',
  job_addr3: '勤務先住所3',
  job_tel1: '勤務先電話番号1',
  job_tel2: '勤務先電話番号2',
  job_fax: '勤務先FAX番号',
  dm_type: 'DM種別',
  dm_flg: 'DM送付フラグ',
  note: '備考',
  memo1: 'メモ1',
  memo2: 'メモ2',
  memo3: 'メモ3',
  memo4: 'メモ4',
  memo5: 'メモ5',
};

export const LEGACY_FIELD_LABELS: Partial<Record<HistoryEntityType, Record<string, string>>> = {
  // t_dankalog → entity_type='Customer'
  Customer: {
    ...LEGACY_COMMON_LABELS,
    request_sei: '申込者姓',
    request_sei_kana: '申込者姓フリガナ',
    request_mei: '申込者名',
    request_mei_kana: '申込者名フリガナ',
    request_zip: '申込者郵便番号',
    request_addr1: '申込者住所1',
    request_addr2: '申込者住所2',
    request_addr3: '申込者住所3',
    request_tel1: '申込者電話番号1',
    request_tel2: '申込者電話番号2',
    request_id: '申込ID',
    auth_no: '許可番号',
    auth_date: '許可日',
    danka_name: '檀家名',
    danka_entry: '檀家加入区分',
    owner_sei: '契約者姓',
    owner_sei_kana: '契約者姓フリガナ',
    owner_mei: '契約者名',
    owner_mei_kana: '契約者名フリガナ',
    send_flg: '送付先フラグ',
    send_zip: '送付先郵便番号',
    send_addr1: '送付先住所1',
    send_addr2: '送付先住所2',
    send_addr3: '送付先住所3',
    send_tel1: '送付先電話番号1',
    shuuha: '宗派',
    seikyu_dm_flg: '請求DM送付フラグ',
    goudou_flg: '合祀フラグ',
    kikan_name: '金融機関名',
    shiten_name: '支店名',
    kouza_type: '口座種別',
    kouza_code: '口座番号',
    kouza_meigi: '口座名義',
    kouza_kigo_ybn: 'ゆうちょ記号',
    kouza_code_ybn: 'ゆうちょ番号',
    jif_matme_code: '自動引落まとめコード',
    jif_bank_code: '自動引落銀行コード',
    jif_siten_code: '自動引落支店コード',
    jif_sinki_kbn: '自動引落新規区分',
    jif_yotei_ymd: '自動引落予定日',
    jif_yotei_kin: '自動引落予定金額',
    jif_kekka_ymd: '自動引落結果日',
    jif_kekka_kbn: '自動引落結果区分',
    jif_kekka_kin: '自動引落結果金額',
    jif_miochi: '自動引落未済区分',
  },
  // t_famlog → entity_type='FamilyContact'
  FamilyContact: {
    ...LEGACY_COMMON_LABELS,
    family_sei: '姓',
    family_sei_kana: '姓フリガナ',
    family_mei: '名',
    family_mei_kana: '名フリガナ',
    zokugara: '続柄',
    family_memo: '家族メモ',
  },
};

/**
 * エンティティ種別ごとの日本語ラベル
 */
export const ENTITY_LABELS: Record<HistoryEntityType, string> = {
  PhysicalPlot: '物理区画',
  ContractPlot: '契約区画',
  Customer: '顧客',
  WorkInfo: '勤務先情報',
  BillingInfo: '請求情報',
  UsageFee: '使用料',
  ManagementFee: '管理料',
  BuriedPerson: '埋葬者',
  ConstructionInfo: '工事情報',
  CollectiveBurial: '合祀情報',
  GravestoneInfo: '墓石情報',
  FamilyContact: '家族連絡先',
  SaleContractRole: '契約役割',
  Document: '書類',
  Billing: '請求',
  Payment: '入金',
};

/**
 * フィールド名から日本語ラベルを取得する
 *
 * @param entityType - エンティティ種別
 * @param fieldName - DBカラム名（例: contract_area_sqm）
 * @returns 日本語ラベル（未定義時はフィールド名そのまま）
 */
export function getFieldLabel(entityType: HistoryEntityType | string, fieldName: string): string {
  const key = entityType as HistoryEntityType;
  const direct = FIELD_LABELS[key]?.[fieldName];
  if (direct !== undefined) return direct;
  // 移行履歴のレガシー列名（t_dankalog/t_famlog）を解決（#376）
  return LEGACY_FIELD_LABELS[key]?.[fieldName] ?? fieldName;
}

/**
 * エンティティ種別の日本語ラベルを取得する
 */
export function getEntityLabel(entityType: HistoryEntityType | string): string {
  return ENTITY_LABELS[entityType as HistoryEntityType] ?? entityType;
}

/**
 * APIレスポンス用に履歴レコードへ日本語ラベル情報を付与する
 *
 * @param history - DBから取得した履歴レコード
 * @returns ラベル情報を付加したオブジェクト
 */
export function formatHistoryWithLabels(history: {
  id: string;
  entity_type: string;
  entity_id: string;
  action_type: string;
  changed_fields: unknown;
  before_record: unknown;
  after_record: unknown;
  changed_by: string | null;
  change_reason: string | null;
  ip_address: string | null;
  created_at: Date;
}): Record<string, unknown> {
  const entityType = history.entity_type;
  const entityLabel = getEntityLabel(entityType);

  // issue #69: 非表示フィールドを除外したレコードを構築
  const filterRecord = (record: unknown): Record<string, unknown> | null => {
    if (!record || typeof record !== 'object') return null;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      if (isHiddenField(key)) continue;
      filtered[key] = value;
    }
    return Object.keys(filtered).length > 0 ? filtered : null;
  };

  const asRecord = (record: unknown): Record<string, unknown> =>
    record && typeof record === 'object' ? (record as Record<string, unknown>) : {};

  // changed_fields の正規化（#385）
  //
  // アプリ内編集（detectChangedFields）は { field: { before, after } } 形で保存するが、
  // 移行履歴（step14-history）は変更フィールド名の文字列配列（例 ["tel1","zip"]）で保存する。
  // 配列を素朴に Object.entries すると { "0":"tel1", "1":"zip" } と数値キー化され、
  // 項目名が「0,1」・前後値が「（未設定）」になる。配列形式を検出したら before_record /
  // after_record（同じレガシー列名でキー化済み）から { field: { before, after } } を
  // 再構成し、フロント HistoryTab が期待する形へ吸収する（本番 9290 件 #354 を無改修で可読化）。
  const filterChangedFields = (fields: unknown): Record<string, unknown> | null => {
    if (!fields) return null;
    const filtered: Record<string, unknown> = {};
    if (Array.isArray(fields)) {
      const before = asRecord(history.before_record);
      const after = asRecord(history.after_record);
      for (const raw of fields) {
        const key = typeof raw === 'string' ? raw : String(raw);
        if (isHiddenField(key)) continue;
        filtered[key] = { before: before[key] ?? null, after: after[key] ?? null };
      }
    } else if (typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
        if (isHiddenField(key)) continue;
        filtered[key] = value;
      }
    } else {
      return null;
    }
    return Object.keys(filtered).length > 0 ? filtered : null;
  };

  const filteredChangedFields = filterChangedFields(history.changed_fields);
  const filteredBeforeRecord = filterRecord(history.before_record);
  const filteredAfterRecord = filterRecord(history.after_record);

  // 日本語ラベルマップを構築（フィルタ後のキーから）
  // - UPDATE: changed_fields のキーから
  // - CREATE: after_record のキーから
  // - DELETE: before_record のキーから
  const fieldLabels: Record<string, string> = {};
  const collectLabels = (record: Record<string, unknown> | null): void => {
    if (record) {
      for (const fieldName of Object.keys(record)) {
        fieldLabels[fieldName] = getFieldLabel(entityType, fieldName);
      }
    }
  };
  if (filteredChangedFields) {
    collectLabels(filteredChangedFields);
  }
  if (history.action_type === 'CREATE') {
    collectLabels(filteredAfterRecord);
  } else if (history.action_type === 'DELETE') {
    collectLabels(filteredBeforeRecord);
  }

  return {
    id: history.id,
    entityType: history.entity_type,
    entityLabel,
    entityId: history.entity_id,
    actionType: history.action_type,
    changedFields: filteredChangedFields,
    fieldLabels,
    beforeRecord: filteredBeforeRecord,
    afterRecord: filteredAfterRecord,
    changedBy: history.changed_by,
    changeReason: history.change_reason,
    ipAddress: history.ip_address,
    createdAt: history.created_at,
  };
}
