import type Database from 'better-sqlite3';
import type { PreChargeRow, WalletWriter, WalletWriterRow } from '../ports/walletWriter.ts';

export class SqliteWalletWriter implements WalletWriter {
  constructor(private db: Database.Database) {}

  bulkCredit(rows: WalletWriterRow[]): void {
    if (rows.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO wallet_transaction 
        (id, wallet_id, type, amount, balance, origin, cycle, cpf, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.walletId,
          'RECHARGE',
          row.amountCents,
          row.amountCents,
          row.origin,
          row.cycle,
          row.cpf,
        );
      }
    });

    transaction();
  }

  bulkPreCharge(rows: PreChargeRow[]): void {
    if (rows.length === 0) return;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO pre_charge
        (id, cpf, phone, amount, cycle, origin, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))
    `);

    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.cpf,
          row.phone,
          row.amountCents,
          row.cycle,
          row.origin,
        );
      }
    });

    transaction();
  }
}
