import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteCheckpoint } from '../src/ingestion/infra/sqliteCheckpoint.ts';

describe('SqliteCheckpoint', () => {
  let db: Database.Database;
  let checkpoint: SqliteCheckpoint;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE ingest_checkpoint (
        file_key   TEXT PRIMARY KEY,
        last_batch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    checkpoint = new SqliteCheckpoint(db);
  });

  it('should return 0 for non-existent fileKey', () => {
    const result = checkpoint.load('non-existent-key');
    expect(result).toBe(0);
  });

  it('should save and load checkpoint', () => {
    checkpoint.save('file-key-1', 3);
    const result = checkpoint.load('file-key-1');
    expect(result).toBe(3);
  });

  it('should update checkpoint on subsequent saves', () => {
    checkpoint.save('file-key-1', 3);
    checkpoint.save('file-key-1', 5);
    const result = checkpoint.load('file-key-1');
    expect(result).toBe(5);
  });

  it('should handle multiple file keys independently', () => {
    checkpoint.save('file-key-1', 3);
    checkpoint.save('file-key-2', 7);
    checkpoint.save('file-key-3', 10);

    expect(checkpoint.load('file-key-1')).toBe(3);
    expect(checkpoint.load('file-key-2')).toBe(7);
    expect(checkpoint.load('file-key-3')).toBe(10);
  });
});
