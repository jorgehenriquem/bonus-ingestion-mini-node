import type { BonusRecord } from './bonusRecord.ts';

export type CreditDecision =
  | { type: 'RECHARGE'; walletId: string; record: BonusRecord }
  | { type: 'PRE_RESERVED'; record: BonusRecord };

export function decideCreditPolicy(
  record: BonusRecord,
  walletId: string | undefined,
): CreditDecision {
  if (walletId) {
    return { type: 'RECHARGE', walletId, record };
  }
  return { type: 'PRE_RESERVED', record };
}
