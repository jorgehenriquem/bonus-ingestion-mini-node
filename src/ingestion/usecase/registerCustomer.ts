import type Database from 'better-sqlite3';
import { redeemPreCharge } from './redeemPreCharge.ts';

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
  const walletId = input.walletId ?? `wallet-${cpf}`;

  db.prepare(`
    INSERT INTO customer (cpf, phone, wallet_id)
    VALUES (?, ?, ?)
    ON CONFLICT(cpf) DO UPDATE SET phone = excluded.phone, wallet_id = excluded.wallet_id
  `).run(cpf, phone, walletId);

  const { redeemed } = redeemPreCharge(db, cpf);

  return { cpf, walletId, redeemed };
}
