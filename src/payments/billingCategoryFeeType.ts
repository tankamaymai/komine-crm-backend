import { BillingCategory } from '@prisma/client';

export const feeTypeFromCategory = (category: BillingCategory): string => {
  const labels: Record<BillingCategory, string> = {
    usage_fee: '使用料',
    management_fee: '管理料',
    collective_fee: '合祀料金',
    construction_fee: '工事料金',
    gravestone_fee: '墓石代',
    other: 'その他',
  };
  return labels[category];
};
