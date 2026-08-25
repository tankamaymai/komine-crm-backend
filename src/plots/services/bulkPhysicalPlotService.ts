/**
 * 空き区画の範囲一括登録（議事録 2026-07-21 §6）
 *
 * 業務要望: 「将来的に区画を増設した場合に備え、『何番から何番まで』と範囲を指定して
 * 空き区画を一括で登録できる機能」。
 *
 * 番号生成と重複の振り分けだけを担う純粋なロジック。DB アクセスは呼び出し側に置き、
 * 番号の組み立て規則と件数上限を単体で検証できるようにしている。
 */
import { ValidationError } from '../../middleware/errorHandler';

/**
 * 一度に登録できる上限。`1〜99999` のような誤入力で数万件が入る事故を防ぐためのガード。
 * 実データの最大エリアが凛B の647件なので、増設1回分としては十分な余裕がある。
 */
export const BULK_REGISTER_MAX_COUNT = 500;

/** 生成した区画番号の組 */
export interface PlotNumberPair {
  /** ユニークキー。区画名を前置して別エリアの同番号と衝突させない */
  plotNumber: string;
  /** 画面表示用。実データは区画名ごとの連番が基本 */
  displayNumber: string;
}

export interface BuildPlotNumbersOptions {
  areaName: string;
  /** 番号の接頭辞（任意）。前後の空白は落とす */
  prefix?: string | undefined;
  startNumber: number;
  endNumber: number;
}

/**
 * 範囲から区画番号の組を生成する。
 *
 * @throws ValidationError 範囲が逆転している場合、または上限件数を超える場合
 */
export function buildPlotNumbersInRange({
  areaName,
  prefix,
  startNumber,
  endNumber,
}: BuildPlotNumbersOptions): PlotNumberPair[] {
  if (startNumber > endNumber) {
    throw new ValidationError('開始番号は終了番号以下で指定してください');
  }

  const count = endNumber - startNumber + 1;
  if (count > BULK_REGISTER_MAX_COUNT) {
    throw new ValidationError(`一度に登録できるのは${BULK_REGISTER_MAX_COUNT}件までです`);
  }

  // 貼り付け由来の空白で番号がずれないよう落とす
  const normalizedPrefix = (prefix ?? '').trim();

  const pairs: PlotNumberPair[] = [];
  for (let n = startNumber; n <= endNumber; n += 1) {
    const displayNumber = `${normalizedPrefix}${n}`;
    pairs.push({ plotNumber: `${areaName}-${displayNumber}`, displayNumber });
  }
  return pairs;
}

export interface SplitResult {
  toCreate: PlotNumberPair[];
  skipped: Array<PlotNumberPair & { reason: string }>;
}

/**
 * 既に登録済みの番号を候補から振り分ける。
 *
 * 区画増設では一部だけ先に登録済みという状況が普通にあるため、重複でエラーにせず
 * スキップして残りを登録する。何をスキップしたかは呼び出し側が利用者へ報告する。
 *
 * @param candidates 生成した番号の組（順序を保って振り分ける）
 * @param existingPlotNumbers 既存の plot_number（論理削除済みも含めて渡すこと。
 *   plot_number は deleted_at を含まない単独 @unique のため、論理削除済みが残っていると
 *   create が P2002 になる）
 */
export function splitByExisting(
  candidates: PlotNumberPair[],
  existingPlotNumbers: string[]
): SplitResult {
  const existing = new Set(existingPlotNumbers);
  const toCreate: PlotNumberPair[] = [];
  const skipped: SplitResult['skipped'] = [];

  for (const candidate of candidates) {
    if (existing.has(candidate.plotNumber)) {
      skipped.push({ ...candidate, reason: 'この区画番号は既に登録されています' });
    } else {
      toCreate.push(candidate);
    }
  }

  return { toCreate, skipped };
}
