/**
 * 請求の作成・更新ルールは、共通パッケージの1枚だけを見る。
 * 裏側に別コピーが残っていると、この比較が落ちる。
 */
import {
  createBillingSchema as sharedCreate,
  updateBillingSchema as sharedUpdate,
} from '@komine/types';
import { createBillingSchema, updateBillingSchema } from '../../src/validations/billingValidation';

describe('請求の入力ルールの出どころ', () => {
  it('作成ルールは共通の1枚と同じもの', () => {
    expect(createBillingSchema).toBe(sharedCreate);
  });

  it('更新ルールは共通の1枚と同じもの', () => {
    expect(updateBillingSchema).toBe(sharedUpdate);
  });

  it('小数の金額は、共通の1枚の言葉で止める', () => {
    const result = createBillingSchema.safeParse({
      contractPlotId: '123e4567-e89b-12d3-a456-426614174000',
      customerId: '123e4567-e89b-12d3-a456-426614174001',
      category: 'usage_fee',
      amount: 1.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('整数');
    }
  });
});
