import type Database from 'better-sqlite3';
import type { CheckpointStore } from '../ports/checkpointStore.ts';

export class SqliteCheckpoint implements CheckpointStore {
  constructor(private db: Database.Database) {}

  load(fileKey: string): number {
    const stmt = this.db.prepare('SELECT last_batch FROM ingest_checkpoint WHERE file_key = ?');
    const row = stmt.get(fileKey) as { last_batch: number } | undefined;
    return row?.last_batch ?? 0;
  }

  save(fileKey: string, batchNo: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO ingest_checkpoint (file_key, last_batch, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(file_key) DO UPDATE SET
        last_batch = excluded.last_batch,
        updated_at = datetime('now')
    `);
    stmt.run(fileKey, batchNo);
  }
}
