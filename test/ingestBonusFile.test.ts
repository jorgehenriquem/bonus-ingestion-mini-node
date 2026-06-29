import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestBonusFile } from '../src/ingestion/usecase/ingestBonusFile.ts';

// ─── helpers ───────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE wallet_transaction (
      id TEXT PRIMARY KEY, wallet_id TEXT NOT NULL, type TEXT NOT NULL,
      amount INTEGER NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL, cycle TEXT NOT NULL, cpf TEXT NOT NULL,
      expires_in TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(origin, cycle, cpf)
    );
    CREATE TABLE customer (cpf TEXT PRIMARY KEY, phone TEXT, wallet_id TEXT NOT NULL);
    CREATE TABLE pre_charge (
      id TEXT PRIMARY KEY, cpf TEXT NOT NULL, phone TEXT, amount INTEGER NOT NULL,
      cycle TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(origin, cycle, cpf)
    );
    CREATE TABLE ingest_checkpoint (
      file_key TEXT PRIMARY KEY, last_batch INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function tmpCsv(name: string, lines: string[]): string {
  const dir = path.join(os.tmpdir(), 'ingestion-test');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, ['cpf,phone,amount,cycle,origin', ...lines].join('\n'));
  return p;
}

// ─── testes ────────────────────────────────────────────────────────────────

describe('ingestBonusFile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    // seed: 2 customers com carteira
    db.exec(`
      INSERT INTO customer (cpf, phone, wallet_id) VALUES
        ('11111111111', '11900000001', 'wallet-001'),
        ('22222222222', '11900000002', 'wallet-002');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('credita clientes existentes e pré-reserva os demais', async () => {
    const csv = tmpCsv('basic.csv', [
      '11111111111,11900000001,50.00,2026-06,vivo',  // tem carteira → RECHARGE
      '22222222222,11900000002,30.00,2026-06,vivo',  // tem carteira → RECHARGE
      '33333333333,11900000003,20.00,2026-06,vivo',  // sem carteira → PRE_RESERVED
    ]);

    const report = await ingestBonusFile(db, { filePath: csv, batchSize: 10 });

    expect(report.read).toBe(3);
    expect(report.credited).toBe(2);
    expect(report.preCharged).toBe(1);
    expect(report.rejected).toBe(0);

    const wt = db.prepare("SELECT * FROM wallet_transaction WHERE type='RECHARGE'").all() as any[];
    expect(wt).toHaveLength(2);

    const pc = db.prepare("SELECT * FROM pre_charge WHERE status='PENDING'").all() as any[];
    expect(pc).toHaveLength(1);
    expect((pc[0] as any).cpf).toBe('33333333333');
  });

  it('rejeita linhas inválidas e continua processando', async () => {
    const csv = tmpCsv('invalid.csv', [
      '11111111111,11900000001,50.00,2026-06,vivo',  // válida
      'INVALIDO,,50.00,2026-06,vivo',                  // cpf inválido
      '22222222222,11900000002,0,2026-06,vivo',        // amount=0
    ]);

    const report = await ingestBonusFile(db, { filePath: csv, batchSize: 10 });

    expect(report.read).toBe(3);
    expect(report.credited).toBe(1);
    expect(report.rejected).toBe(2);
  });

  it('idempotência: reprocessar o mesmo arquivo não duplica registros', async () => {
    const csv = tmpCsv('idem.csv', [
      '11111111111,11900000001,50.00,2026-06,vivo',
      '33333333333,11900000003,20.00,2026-06,vivo',
    ]);

    const r1 = await ingestBonusFile(db, { filePath: csv, batchSize: 10, resume: false });
    const r2 = await ingestBonusFile(db, { filePath: csv, batchSize: 10, resume: false });

    expect(r1.credited).toBe(1);
    expect(r1.preCharged).toBe(1);

    // Segundo run: INSERT OR IGNORE → mesmas métricas (nada inserido de novo)
    // Os counts nas tabelas não crescem
    const wtCount = (db.prepare('SELECT COUNT(*) as n FROM wallet_transaction').get() as any).n;
    const pcCount = (db.prepare('SELECT COUNT(*) as n FROM pre_charge').get() as any).n;
    expect(wtCount).toBe(1);
    expect(pcCount).toBe(1);

    // O relatório do segundo run ainda conta como "lido/creditado" (tentativa)
    // mas o banco não duplica
    expect(r2.read).toBe(2);
  });

  it('checkpoint/resume: retoma do último lote confirmado', async () => {
    // 6 linhas, batchSize=2 → 3 lotes
    const csv = tmpCsv('resume.csv', [
      '11111111111,11900000001,10.00,2026-06,vivo',
      '22222222222,11900000002,10.00,2026-06,vivo',
      '33333333333,,10.00,2026-06,vivo',
      '44444444444,,10.00,2026-06,vivo',
      '55555555555,,10.00,2026-06,vivo',
      '66666666666,,10.00,2026-06,vivo',
    ]);

    // Simula run1 que processa só os 2 primeiros lotes (manualmente avançamos o checkpoint)
    const { SqliteCheckpoint } = await import('../src/ingestion/infra/sqliteCheckpoint.ts');
    const cp = new SqliteCheckpoint(db);
    const fileKey = path.basename(csv);
    cp.save(fileKey, 2); // simula: lotes 1 e 2 já processados

    // Seed manual: insere o que os lotes 1 e 2 teriam inserido
    db.exec(`
      INSERT INTO wallet_transaction (id, wallet_id, type, amount, balance, origin, cycle, cpf)
        VALUES ('vivo:2026-06:11111111111', 'wallet-001', 'RECHARGE', 1000, 1000, 'vivo', '2026-06', '11111111111'),
               ('vivo:2026-06:22222222222', 'wallet-002', 'RECHARGE', 1000, 1000, 'vivo', '2026-06', '22222222222');
      INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin)
        VALUES ('vivo:2026-06:33333333333', '33333333333', NULL, 1000, '2026-06', 'vivo'),
               ('vivo:2026-06:44444444444', '44444444444', NULL, 1000, '2026-06', 'vivo');
    `);

    // Run2: resume=true → pula lotes 1 e 2, processa só o lote 3
    const report = await ingestBonusFile(db, { filePath: csv, batchSize: 2, resume: true });

    // Leu todas as 6 linhas, mas creditou só o lote 3 (linhas 5-6)
    expect(report.read).toBe(6);
    expect(report.credited + report.preCharged).toBe(2);

    // Checkpoint deve estar em 3
    expect(cp.load(fileKey)).toBe(3);
  });

  it('smoke test de memória: arquivo grande mantém RSS abaixo de 150MB', async () => {
    // Gera 10.000 linhas em arquivo temporário
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const cpf = String(i).padStart(11, '0');
      lines.push(`${cpf},,1.00,2026-06,vivo`);
    }
    const csv = tmpCsv('large.csv', lines);

    const before = process.memoryUsage().rss;
    await ingestBonusFile(db, { filePath: csv, batchSize: 500, resume: false });
    const after = process.memoryUsage().rss;

    const deltaMB = (after - before) / 1024 / 1024;
    // Crescimento de RSS deve ser razoável (< 100MB de delta para 10k linhas)
    expect(deltaMB).toBeLessThan(100);
  }, 30_000);
});
