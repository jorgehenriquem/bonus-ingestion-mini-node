import type Database from 'better-sqlite3';
import { daysFromNow, DEFAULT_EXPIRY_DAYS } from '../domain/expiry.ts';

export type RedeemResult = {
  redeemed: number;
};

export function redeemPreCharge(
  db: Database.Database,
  cpf: string,
): RedeemResult {
  // 1. Buscar o wallet_id do customer com esse cpf
  const customerStmt = db.prepare('SELECT wallet_id FROM customer WHERE cpf = ?');
  const customer = customerStmt.get(cpf) as { wallet_id: string } | undefined;

  if (!customer) {
    return { redeemed: 0 };
  }

  const walletId = customer.wallet_id;

  // 2. Buscar todos os pre_charge com cpf = ? e status = 'PENDING'
  const preChargesStmt = db.prepare(
    'SELECT id, amount, cycle, origin FROM pre_charge WHERE cpf = ? AND status = ?',
  );
  const preCharges = preChargesStmt.all(cpf, 'PENDING') as Array<{
    id: string;
    amount: number;
    cycle: string;
    origin: string;
  }>;

  if (preCharges.length === 0) {
    return { redeemed: 0 };
  }

  // 3. Para cada pre_charge, em uma única transação SQLite:
  let redeemed = 0;

  const expiresIn = daysFromNow(DEFAULT_EXPIRY_DAYS);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO wallet_transaction (
      id,
      wallet_id,
      type,
      amount,
      balance,
      origin,
      cycle,
      cpf,
      expires_in,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const updateStmt = db.prepare(
    'UPDATE pre_charge SET status = ? WHERE id = ?',
  );

  db.transaction(() => {
    for (const preCharge of preCharges) {
      // a. INSERT OR IGNORE into wallet_transaction (PK determinística)
      insertStmt.run(
        preCharge.id, // id = ${origin}:${cycle}:${cpf}
        walletId,
        'RECHARGE',
        preCharge.amount,
        preCharge.amount, // balance = amount
        preCharge.origin,
        preCharge.cycle,
        cpf,
        expiresIn,
      );

      // b. UPDATE pre_charge SET status='REDEEMED'
      updateStmt.run('REDEEMED', preCharge.id);

      redeemed++;
    }
  })();

  return { redeemed };
}
