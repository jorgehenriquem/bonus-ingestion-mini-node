import type Database from 'better-sqlite3';
import type { CustomerLookup } from '../ports/customerLookup.ts';

export class SqliteCustomerLookup implements CustomerLookup {
  constructor(private db: Database.Database) {}

  findWalletsByKeys(keys: string[]): Map<string, string> {
    if (keys.length === 0) return new Map();

    const placeholders = keys.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT cpf, wallet_id FROM customer WHERE cpf IN (${placeholders})
    `);
    const rows = stmt.all(...keys) as Array<{ cpf: string; wallet_id: string }>;

    const result = new Map<string, string>();
    for (const row of rows) {
      result.set(row.cpf, row.wallet_id);
    }
    return result;
  }
}
