import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { redeemPreCharge } from './redeemPreCharge.ts';

// Deterministic so re-registering the same CPF keeps the same wallet, and
// derived by hash so the identifier never carries the CPF itself.
export function deriveWalletId(cpf: string): string {
  return `wallet-${createHash('sha256').update(cpf).digest('hex').slice(0, 12)}`;
}

export type RegisterCustomerInput = {
  cpf: string;
  phone?: string | null;
  walletId?: string | null;
};

export type RegisterCustomerResult = {
  cpf: string;
  walletId: string;
  redeemed: number;
};

export function registerCustomer(
  db: Database.Database,
  input: RegisterCustomerInput,
): RegisterCustomerResult {
  const { cpf } = input;
  const phone = input.phone ?? null;
  const walletId = input.walletId ?? deriveWalletId(cpf);

  db.prepare(`
    INSERT INTO customer (cpf, phone, wallet_id)
    VALUES (?, ?, ?)
    ON CONFLICT(cpf) DO UPDATE SET phone = excluded.phone, wallet_id = excluded.wallet_id
  `).run(cpf, phone, walletId);

  const { redeemed } = redeemPreCharge(db, cpf);

  return { cpf, walletId, redeemed };
}
