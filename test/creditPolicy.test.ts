import { describe, it, expect } from 'vitest';
import { decideCreditPolicy } from '../src/ingestion/domain/creditPolicy.ts';
import type { BonusRecord } from '../src/ingestion/domain/bonusRecord.ts';

const record: BonusRecord = {
  cpf: '12345678901',
  phone: '11999990000',
  amountCents: 5000,
  cycle: '2026-06',
  origin: 'vivo',
};

describe('decideCreditPolicy', () => {
  it('cpf com walletId retorna RECHARGE', () => {
    const d = decideCreditPolicy(record, 'wallet-abc');
    expect(d.type).toBe('RECHARGE');
    if (d.type !== 'RECHARGE') return;
    expect(d.walletId).toBe('wallet-abc');
    expect(d.record).toBe(record);
  });

  it('cpf sem walletId retorna PRE_RESERVED', () => {
    const d = decideCreditPolicy(record, undefined);
    expect(d.type).toBe('PRE_RESERVED');
    expect(d.record).toBe(record);
  });

  it('walletId vazio retorna PRE_RESERVED', () => {
    const d = decideCreditPolicy(record, '');
    expect(d.type).toBe('PRE_RESERVED');
  });
});
