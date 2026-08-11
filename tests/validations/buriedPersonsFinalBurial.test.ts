/**
 * 埋葬者バリデーション: 最終納骨者は1契約区画につき1人まで（議事録 2026-07-21 §1）
 *
 * 複数指定されると合祀カウントダウンの起点日が一意に決まらない。
 * createPlot / updatePlot の埋葬者はどちらも全置換（入力に無い既存行は soft-delete）
 * なので、配列内の検査で DB 上の重複も防げる。
 */
import { buriedPersonsSchema } from '../../src/validations/plotValidation';

describe('buriedPersonsSchema（最終納骨者の一意性）', () => {
  it('最終納骨者が1人なら通す', () => {
    const result = buriedPersonsSchema.safeParse([
      { name: '田中一郎', isFinalBurial: false },
      { name: '田中花子', isFinalBurial: true },
    ]);
    expect(result.success).toBe(true);
  });

  it('最終納骨者が2人以上なら弾く', () => {
    const result = buriedPersonsSchema.safeParse([
      { name: '田中一郎', isFinalBurial: true },
      { name: '田中花子', isFinalBurial: true },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('最終納骨者は1人までしか指定できません');
    }
  });

  // _delete はスキーマが受け付けるだけでコントローラが解釈しない死んだフィールドのため、
  // 「削除予定だから数えない」という扱いはできない（そのまま is_final_burial=true で
  // 保存され最終納骨者が2人になる）。付け替えは対象を配列から外す（id 突合で soft-delete）か
  // isFinalBurial を false にして行う。
  it('_delete 付きでも最終納骨者として数える', () => {
    const result = buriedPersonsSchema.safeParse([
      { name: '田中一郎', isFinalBurial: true, _delete: true },
      { name: '田中花子', isFinalBurial: true },
    ]);
    expect(result.success).toBe(false);
  });

  it('配列から外して付け替えるのは通る（id 突合で既存行は soft-delete される）', () => {
    const result = buriedPersonsSchema.safeParse([{ name: '田中花子', isFinalBurial: true }]);
    expect(result.success).toBe(true);
  });

  it('最終納骨者が未指定でも通す（契約日起点にフォールバックする）', () => {
    expect(buriedPersonsSchema.safeParse([{ name: '田中一郎' }]).success).toBe(true);
    expect(buriedPersonsSchema.safeParse([]).success).toBe(true);
  });

  it('isFinalBurial 未指定は false 相当として扱う', () => {
    const result = buriedPersonsSchema.safeParse([
      { name: '田中一郎' },
      { name: '田中花子' },
      { name: '田中次郎', isFinalBurial: true },
    ]);
    expect(result.success).toBe(true);
  });
});
