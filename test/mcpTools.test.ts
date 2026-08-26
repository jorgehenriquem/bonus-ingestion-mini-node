import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/mcp/server.ts';

const SCHEMA = `
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX idx_wt_recharge_idempotency
    ON wallet_transaction(origin, cycle, cpf) WHERE type = 'RECHARGE';

  CREATE TABLE customer (
    cpf       TEXT PRIMARY KEY,
    phone     TEXT,
    wallet_id TEXT NOT NULL
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

  CREATE TABLE ingest_checkpoint (
    file_key   TEXT PRIMARY KEY,
    last_batch INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

describe('servidor MCP', () => {
  let db: Database.Database;
  let client: Client;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(SCHEMA);

    db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)').run(
      '11111111111',
      '11999990000',
      'wallet-aaa',
    );
    db.prepare(`
      INSERT INTO wallet_transaction (id, wallet_id, type, amount, balance, origin, cycle, cpf, expires_in)
      VALUES ('vivo:2026-06:11111111111', 'wallet-aaa', 'RECHARGE', 5000, 5000, 'vivo', '2026-06', '11111111111', ?)
    `).run(new Date(Date.now() + 86_400_000).toISOString());
    db.prepare(`
      INSERT INTO wallet_transaction (id, wallet_id, type, amount, balance, origin, cycle, cpf, expires_in)
      VALUES ('vivo:2026-05:11111111111', 'wallet-aaa', 'RECHARGE', 1000, 1000, 'vivo', '2026-05', '11111111111', ?)
    `).run(new Date(Date.now() - 86_400_000).toISOString());
    db.prepare(`
      INSERT INTO pre_charge (id, cpf, phone, amount, cycle, origin, status)
      VALUES ('vivo:2026-06:22222222222', '22222222222', '11988880000', 7500, '2026-06', 'vivo', 'PENDING')
    `).run();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([
      buildServer(db).connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    db.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
      content: Array<{ type: string; text: string }>;
    };

  it('expõe as tools esperadas', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      'cancel_ingestion',
      'generate_sample_csv',
      'get_data_root',
      'get_ingestion_status',
      'get_wallet_summary',
      'list_rejected_rows',
      'lookup_customer',
      'register_customer',
      'start_ingestion',
    ]);
  });

  it('get_wallet_summary agrega créditos e pré-recargas', async () => {
    const res = await call('get_wallet_summary');

    expect(res.structuredContent).toMatchObject({
      recharges: 2,
      totalCents: 6000,
      expiredCount: 1,
      preChargesPending: 1,
      preChargesRedeemed: 0,
      preChargesPendingCents: 7500,
    });
  });

  it('get_wallet_summary filtra por cycle', async () => {
    const res = await call('get_wallet_summary', { cycle: '2026-06' });

    expect(res.structuredContent).toMatchObject({ recharges: 1, totalCents: 5000, expiredCount: 0 });
  });

  it('lookup_customer encontra cadastro e mascara o cpf', async () => {
    const res = await call('lookup_customer', { cpf: '11111111111' });

    expect(res.structuredContent).toMatchObject({
      found: true,
      walletId: 'wallet-aaa',
      recharges: 2,
      pendingPreCharges: 0,
    });
    expect(res.structuredContent!['cpf']).toBe('111.***.**1-11');
    expect(JSON.stringify(res)).not.toContain('11111111111');
  });

  it('lookup_customer devolve pendências de quem não tem cadastro', async () => {
    const res = await call('lookup_customer', { cpf: '22222222222' });

    expect(res.structuredContent).toMatchObject({
      found: false,
      walletId: null,
      pendingPreCharges: 1,
      pendingCents: 7500,
    });
  });

  it('lookup_customer exige cpf ou phone', async () => {
    const res = await call('lookup_customer');
    expect(res.isError).toBe(true);
  });

  it('register_customer converte a pré-recarga pendente', async () => {
    const res = await call('register_customer', { cpf: '22222222222' });

    expect(res.structuredContent).toMatchObject({ redeemed: 1 });
    expect(JSON.stringify(res)).not.toContain('22222222222');

    const row = db
      .prepare(`SELECT status FROM pre_charge WHERE id = 'vivo:2026-06:22222222222'`)
      .get() as { status: string };
    expect(row.status).toBe('REDEEMED');
  });

  it('register_customer é idempotente', async () => {
    await call('register_customer', { cpf: '22222222222' });
    const second = await call('register_customer', { cpf: '22222222222' });

    expect(second.structuredContent).toMatchObject({ redeemed: 0 });

    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM wallet_transaction WHERE cpf = '22222222222'`)
      .get() as { n: number };
    expect(n).toBe(1);
  });

  it('register_customer rejeita cpf malformado', async () => {
    const res = await call('register_customer', { cpf: '123' });
    expect(res.isError).toBe(true);
  });

  it('start_ingestion rejeita caminho fora da raiz', async () => {
    const res = await call('start_ingestion', { filePath: '../../etc/passwd' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('raiz permitida');
  });

  it('list_rejected_rows devolve vazio quando não há arquivo de rejeição', async () => {
    const res = await call('list_rejected_rows', { filePath: 'inexistente.csv' });

    expect(res.structuredContent).toMatchObject({ total: 0, returned: 0, rows: [] });
  });

  it('get_ingestion_status sem jobId lista vazio', async () => {
    const res = await call('get_ingestion_status');
    expect(res.structuredContent!['jobs']).toEqual([]);
  });
});
