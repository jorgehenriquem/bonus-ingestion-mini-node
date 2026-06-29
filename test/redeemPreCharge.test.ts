import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { redeemPreCharge } from '../src/ingestion/usecase/redeemPreCharge.ts';

describe('redeemPreCharge', () => {
  let db: Database.Database;

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

      CREATE INDEX idx_wt_wallet ON wallet_transaction(wallet_id);
      CREATE INDEX idx_wt_type ON wallet_transaction(type);

      CREATE TABLE customer (
        cpf       TEXT PRIMARY KEY,
        phone     TEXT,
        wallet_id TEXT NOT NULL
      );

      CREATE UNIQUE INDEX idx_customer_phone ON customer(phone) WHERE phone IS NOT NULL;

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

      CREATE INDEX idx_pc_cpf ON pre_charge(cpf);
    `);
  });

  it('should convert all PENDING pre_charge records to RECHARGE', () => {
    const cpf = '12345678901';
    const walletId = 'wallet-001';
    const phone = '11999990000';

    db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)').run(
      cpf,
      phone,
      walletId,
    );

    db.prepare(
      `INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run('vivo:2026-06:12345678901', cpf, phone, 5000, '2026-06', 'vivo');

    db.prepare(
      `INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run('vivo:2026-07:12345678901', cpf, phone, 3000, '2026-07', 'vivo');

    const result = redeemPreCharge(db, cpf);

    expect(result.redeemed).toBe(2);

    const walletRows = db.prepare('SELECT * FROM wallet_transaction ORDER BY cycle').all() as Array<{
      id: string;
      wallet_id: string;
      type: string;
      amount: number;
      balance: number;
      origin: string;
      cycle: string;
      cpf: string;
    }>;

    expect(walletRows).toHaveLength(2);
    expect(walletRows[0]).toMatchObject({
      id: 'vivo:2026-06:12345678901',
      wallet_id: walletId,
      type: 'RECHARGE',
      amount: 5000,
      balance: 5000,
      origin: 'vivo',
      cycle: '2026-06',
      cpf,
    });
    expect(walletRows[1]).toMatchObject({
      id: 'vivo:2026-07:12345678901',
      wallet_id: walletId,
      type: 'RECHARGE',
      amount: 3000,
      balance: 3000,
      origin: 'vivo',
      cycle: '2026-07',
      cpf,
    });

    const preChargeRows = db.prepare('SELECT * FROM pre_charge ORDER BY cycle').all() as Array<{
      id: string;
      cpf: string;
      phone: string | null;
      amount: number;
      cycle: string;
      origin: string;
      status: string;
    }>;

    expect(preChargeRows).toHaveLength(2);
    expect(preChargeRows[0].status).toBe('REDEEMED');
    expect(preChargeRows[1].status).toBe('REDEEMED');
  });

  it('should return { redeemed: 0 } if cpf has no customer record', () => {
    const cpf = '12345678901';

    db.prepare(
      `INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run('vivo:2026-06:12345678901', cpf, '11999990000', 5000, '2026-06', 'vivo');

    const result = redeemPreCharge(db, cpf);

    expect(result.redeemed).toBe(0);

    const preChargeRows = db.prepare('SELECT * FROM pre_charge').all() as Array<{
      status: string;
    }>;

    expect(preChargeRows).toHaveLength(1);
    expect(preChargeRows[0].status).toBe('PENDING');

    const walletRows = db.prepare('SELECT * FROM wallet_transaction').all();
    expect(walletRows).toHaveLength(0);
  });

  it('should be idempotent: second call returns { redeemed: 0 } when all are REDEEMED', () => {
    const cpf = '12345678901';
    const walletId = 'wallet-001';
    const phone = '11999990000';

    db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)').run(
      cpf,
      phone,
      walletId,
    );

    db.prepare(
      `INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run('vivo:2026-06:12345678901', cpf, phone, 5000, '2026-06', 'vivo');

    const result1 = redeemPreCharge(db, cpf);
    expect(result1.redeemed).toBe(1);

    const result2 = redeemPreCharge(db, cpf);
    expect(result2.redeemed).toBe(0);

    const walletRows = db.prepare('SELECT COUNT(*) as count FROM wallet_transaction').get() as {
      count: number;
    };
    expect(walletRows.count).toBe(1);

    const preChargeRows = db.prepare('SELECT status FROM pre_charge').all() as Array<{
      status: string;
    }>;
    expect(preChargeRows).toHaveLength(1);
    expect(preChargeRows[0].status).toBe('REDEEMED');
  });

  it('should not affect pre_charge records of other cpfs', () => {
    const cpf1 = '12345678901';
    const cpf2 = '11111111111';
    const walletId1 = 'wallet-001';
    const walletId2 = 'wallet-002';

    db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)').run(
      cpf1,
      '11999990000',
      walletId1,
    );
    db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)').run(
      cpf2,
      '21999990000',
      walletId2,
    );

    db.prepare(
      `INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run('vivo:2026-06:12345678901', cpf1, '11999990000', 5000, '2026-06', 'vivo');

    db.prepare(
      `INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
    ).run('vivo:2026-06:11111111111', cpf2, '21999990000', 3000, '2026-06', 'vivo');

    const result = redeemPreCharge(db, cpf1);
    expect(result.redeemed).toBe(1);

    const preCharge1 = db.prepare('SELECT status FROM pre_charge WHERE cpf = ?').get(cpf1) as {
      status: string;
    };
    expect(preCharge1.status).toBe('REDEEMED');

    const preCharge2 = db.prepare('SELECT status FROM pre_charge WHERE cpf = ?').get(cpf2) as {
      status: string;
    };
    expect(preCharge2.status).toBe('PENDING');

    const walletRows = db.prepare('SELECT cpf FROM wallet_transaction').all() as Array<{ cpf: string }>;
    expect(walletRows).toHaveLength(1);
    expect(walletRows[0].cpf).toBe(cpf1);
  });
});
