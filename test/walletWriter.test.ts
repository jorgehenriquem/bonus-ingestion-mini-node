import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteWalletWriter } from '../src/ingestion/infra/sqliteWalletWriter.ts';
import { randomUUID } from 'node:crypto';

describe('SqliteWalletWriter', () => {
  let db: Database.Database;
  let writer: SqliteWalletWriter;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE wallet_transaction (
        id         TEXT PRIMARY KEY,
        wallet_id  TEXT NOT NULL,
        type       TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        balance    INTEGER NOT NULL DEFAULT 0,
        origin     TEXT NOT NULL,
        cycle      TEXT NOT NULL,
        cpf        TEXT NOT NULL,
        expires_in TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(origin, cycle, cpf)
      );

      CREATE TABLE pre_charge (
        id         TEXT PRIMARY KEY,
        cpf        TEXT NOT NULL,
        phone      TEXT,
        amount     INTEGER NOT NULL,
        cycle      TEXT NOT NULL,
        origin     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'PENDING',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(origin, cycle, cpf)
      );
    `);

    writer = new SqliteWalletWriter(db);
  });

  describe('bulkCredit', () => {
    it('should insert credit rows into wallet_transaction', () => {
      const rows = [
        {
          id: randomUUID(),
          walletId: 'wallet-1',
          amountCents: 5000,
          cycle: '2026-06',
          origin: 'vivo',
          cpf: '12345678901',
          expiresIn: new Date(Date.now() + 180 * 86400000).toISOString(),
        },
        {
          id: randomUUID(),
          walletId: 'wallet-2',
          amountCents: 10000,
          cycle: '2026-06',
          origin: 'vivo',
          cpf: '11111111111',
          expiresIn: new Date(Date.now() + 180 * 86400000).toISOString(),
        },
      ];

      writer.bulkCredit(rows);

      const stmt = db.prepare('SELECT * FROM wallet_transaction ORDER BY cpf');
      const result = stmt.all() as Array<{
        id: string;
        wallet_id: string;
        type: string;
        amount: number;
        balance: number;
        origin: string;
        cycle: string;
        cpf: string;
      }>;

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        wallet_id: 'wallet-2',
        type: 'RECHARGE',
        amount: 10000,
        balance: 10000,
        origin: 'vivo',
        cycle: '2026-06',
        cpf: '11111111111',
      });
      expect(result[1]).toMatchObject({
        wallet_id: 'wallet-1',
        type: 'RECHARGE',
        amount: 5000,
        balance: 5000,
        origin: 'vivo',
        cycle: '2026-06',
        cpf: '12345678901',
      });
    });

    it('should not duplicate rows on idempotent insert', () => {
      const rows = [
        {
          id: 'id-1',
          walletId: 'wallet-1',
          amountCents: 5000,
          cycle: '2026-06',
          origin: 'vivo',
          cpf: '12345678901',
          expiresIn: new Date(Date.now() + 180 * 86400000).toISOString(),
        },
      ];

      writer.bulkCredit(rows);
      writer.bulkCredit(rows);

      const stmt = db.prepare('SELECT COUNT(*) as count FROM wallet_transaction');
      const result = stmt.get() as { count: number };
      expect(result.count).toBe(1);
    });

    it('should handle empty rows array', () => {
      expect(() => writer.bulkCredit([])).not.toThrow();
      const stmt = db.prepare('SELECT COUNT(*) as count FROM wallet_transaction');
      const result = stmt.get() as { count: number };
      expect(result.count).toBe(0);
    });
  });

  describe('bulkPreCharge', () => {
    it('should insert pre-charge rows', () => {
      const rows = [
        {
          id: randomUUID(),
          cpf: '12345678901',
          phone: '11999990000',
          amountCents: 5000,
          cycle: '2026-06',
          origin: 'vivo',
        },
        {
          id: randomUUID(),
          cpf: '11111111111',
          phone: null,
          amountCents: 10000,
          cycle: '2026-06',
          origin: 'vivo',
        },
      ];

      writer.bulkPreCharge(rows);

      const stmt = db.prepare('SELECT * FROM pre_charge ORDER BY cpf');
      const result = stmt.all() as Array<{
        id: string;
        cpf: string;
        phone: string | null;
        amount: number;
        cycle: string;
        origin: string;
        status: string;
      }>;

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        cpf: '11111111111',
        phone: null,
        amount: 10000,
        cycle: '2026-06',
        origin: 'vivo',
        status: 'PENDING',
      });
      expect(result[1]).toMatchObject({
        cpf: '12345678901',
        phone: '11999990000',
        amount: 5000,
        cycle: '2026-06',
        origin: 'vivo',
        status: 'PENDING',
      });
    });

    it('should not duplicate rows on idempotent insert', () => {
      const rows = [
        {
          id: 'id-1',
          cpf: '12345678901',
          phone: '11999990000',
          amountCents: 5000,
          cycle: '2026-06',
          origin: 'vivo',
        },
      ];

      writer.bulkPreCharge(rows);
      writer.bulkPreCharge(rows);

      const stmt = db.prepare('SELECT COUNT(*) as count FROM pre_charge');
      const result = stmt.get() as { count: number };
      expect(result.count).toBe(1);
    });

    it('should handle empty rows array', () => {
      expect(() => writer.bulkPreCharge([])).not.toThrow();
      const stmt = db.prepare('SELECT COUNT(*) as count FROM pre_charge');
      const result = stmt.get() as { count: number };
      expect(result.count).toBe(0);
    });
  });
});
