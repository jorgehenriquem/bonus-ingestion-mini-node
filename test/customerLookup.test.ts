import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteCustomerLookup } from '../src/ingestion/infra/sqliteCustomerLookup.ts';

describe('SqliteCustomerLookup', () => {
  let db: Database.Database;
  let lookup: SqliteCustomerLookup;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE customer (
        cpf       TEXT PRIMARY KEY,
        phone     TEXT,
        wallet_id TEXT NOT NULL
      );
    `);

    const insertStmt = db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)');
    insertStmt.run('12345678901', '11999990000', 'wallet-1');
    insertStmt.run('11111111111', '11988880000', 'wallet-2');
    insertStmt.run('22222222222', '11977770000', 'wallet-3');

    lookup = new SqliteCustomerLookup(db);
  });

  it('should find wallets by cpf keys', () => {
    const result = lookup.findWalletsByKeys(['12345678901', '11111111111']);
    expect(result.size).toBe(2);
    expect(result.get('12345678901')).toBe('wallet-1');
    expect(result.get('11111111111')).toBe('wallet-2');
  });

  it('should return empty map for non-existent keys', () => {
    const result = lookup.findWalletsByKeys(['99999999999', '88888888888']);
    expect(result.size).toBe(0);
  });

  it('should handle mixed existing and non-existent keys', () => {
    const result = lookup.findWalletsByKeys([
      '12345678901',
      '99999999999',
      '11111111111',
      '88888888888',
      '22222222222',
    ]);
    expect(result.size).toBe(3);
    expect(result.get('12345678901')).toBe('wallet-1');
    expect(result.get('11111111111')).toBe('wallet-2');
    expect(result.get('22222222222')).toBe('wallet-3');
    expect(result.get('99999999999')).toBeUndefined();
    expect(result.get('88888888888')).toBeUndefined();
  });

  it('should return empty map for empty keys array', () => {
    const result = lookup.findWalletsByKeys([]);
    expect(result.size).toBe(0);
  });
});
