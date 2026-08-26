import { createInterface } from 'node:readline';
import { getDb, closeDb } from '../ingestion/infra/db.ts';
import { ingestBonusFile } from '../ingestion/usecase/ingestBonusFile.ts';
import type { IngestOptions } from '../ingestion/usecase/ingestBonusFile.ts';

type ChildOptions = Pick<
  IngestOptions,
  'filePath' | 'batchSize' | 'resume' | 'expiredRate'
>;

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let cancelRequested = false;

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === 'cancel') cancelRequested = true;
});

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error('opções não fornecidas');

  const opts = JSON.parse(raw) as ChildOptions;
  const db = getDb();

  try {
    const report = await ingestBonusFile(db, {
      ...opts,
      onProgress: (snapshot) => emit({ type: 'progress', snapshot }),
      shouldCancel: () => cancelRequested,
    });
    emit({ type: 'done', report });
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
