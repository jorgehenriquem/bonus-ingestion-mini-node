import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env['DB_PATH'] ?? path.resolve(__dirname, '../../../data/ingestion.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_transaction (
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

    CREATE INDEX IF NOT EXISTS idx_wt_wallet ON wallet_transaction(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_wt_type   ON wallet_transaction(type);

    CREATE TABLE IF NOT EXISTS customer (
      cpf       TEXT PRIMARY KEY,
      phone     TEXT,
      wallet_id TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_phone ON customer(phone) WHERE phone IS NOT NULL;

    CREATE TABLE IF NOT EXISTS pre_charge (
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

    CREATE INDEX IF NOT EXISTS idx_pc_cpf ON pre_charge(cpf);

    CREATE TABLE IF NOT EXISTS ingest_checkpoint (
      file_key   TEXT PRIMARY KEY,
      last_batch INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
