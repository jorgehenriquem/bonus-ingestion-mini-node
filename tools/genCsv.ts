import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { getDb, closeDb } from '../src/ingestion/infra/db.ts';
import { log } from '../src/ingestion/infra/logger.ts';

export type GenerateCsvOptions = {
  rows?: number;
  hitRate?: number;
  output?: string;
  seedCustomers?: boolean;
  cycle?: string;
  origin?: string;
};

export type GenerateCsvResult = {
  filePath: string;
  rows: number;
  hitRate: number;
  seededCustomers: number;
  sizeBytes: number;
  durationMs: number;
};

const DEFAULT_CYCLE = process.env['BONUS_CYCLE'] ?? '2026-06';
const DEFAULT_ORIGIN = process.env['BONUS_ORIGIN'] ?? 'vivo';

export async function generateCsv(
  db: Database.Database,
  opts: GenerateCsvOptions = {},
): Promise<GenerateCsvResult> {
  const rows = Math.floor(opts.rows ?? 100_000);
  const hitRate = Math.min(1, Math.max(0, opts.hitRate ?? 0.7));
  const output = opts.output ?? 'data/sample.csv';
  const seedCustomers = opts.seedCustomers !== false;
  const cycle = opts.cycle ?? DEFAULT_CYCLE;
  const origin = opts.origin ?? DEFAULT_ORIGIN;

  log(`[genCsv] gerando ${rows.toLocaleString()} linhas (${(hitRate * 100).toFixed(1)}% hit-rate)`);
  log(`[genCsv] output: ${output}`);

  const startMs = Date.now();
  let seededCustomers = 0;

  db.prepare('DELETE FROM customer WHERE 1=1').run();
  db.prepare('DELETE FROM pre_charge WHERE 1=1').run();

  if (seedCustomers) {
    log('[genCsv] seeding customers...');

    const hitCount = Math.floor(rows * hitRate);
    const stmt = db.prepare('INSERT INTO customer (cpf, phone, wallet_id) VALUES (?, ?, ?)');
    const transaction = db.transaction((batchWithOffset: [string[], number]) => {
      const [cpfList, startIdx] = batchWithOffset;
      for (let i = 0; i < cpfList.length; i++) {
        const cpf = cpfList[i];
        const phone = `119${String(startIdx + i).padStart(8, '0')}`;
        const walletId = `wallet-${cpf.slice(-6)}`;
        stmt.run(cpf, phone, walletId);
      }
    });

    const batchSize = 5000;
    const cpfs: string[] = [];
    let phoneIdx = 0;
    for (let i = 0; i < hitCount; i++) {
      cpfs.push(String(i).padStart(11, '0'));
      if (cpfs.length >= batchSize) {
        transaction([cpfs, phoneIdx]);
        phoneIdx += cpfs.length;
        cpfs.length = 0;
      }
    }
    if (cpfs.length > 0) {
      transaction([cpfs, phoneIdx]);
    }

    seededCustomers = hitCount;
    log(`[genCsv] ${hitCount.toLocaleString()} customers criados`);
  }

  const writer = createWriteStream(output, { encoding: 'utf-8' });

  log('[genCsv] escrevendo CSV...');

  writer.write('cpf,phone,amount,cycle,origin\n');

  let written = 0;
  let prevLogPercent = 0;

  for (let i = 0; i < rows; i++) {
    const cpf = String(i).padStart(11, '0');
    const phone = `119${String(Math.random()).slice(2, 10)}`;
    const amount = (5 + Math.random() * 95).toFixed(2);

    writer.write(`${cpf},${phone},${amount},${cycle},${origin}\n`);

    written++;

    const percent = Math.floor((written / rows) * 100);
    if (percent >= prevLogPercent + 10) {
      const elapsed = (Date.now() - startMs) / 1000;
      const rps = elapsed > 0 ? Math.round(written / elapsed) : 0;
      log(`[genCsv] ${percent}% (${written.toLocaleString()}/${rows.toLocaleString()}) ${rps} r/s`);
      prevLogPercent = percent;
    }
  }

  await new Promise<void>((resolve, reject) => {
    writer.end(() => resolve());
    writer.on('error', reject);
  });

  const durationMs = Date.now() - startMs;
  const { size } = await stat(output);

  log(`[genCsv] concluído em ${(durationMs / 1000).toFixed(1)}s`);

  return {
    filePath: output,
    rows,
    hitRate,
    seededCustomers,
    sizeBytes: size,
    durationMs,
  };
}

function parseArgs(argv: string[]) {
  const params: Record<string, string | number | boolean> = {
    rows: 100_000,
    'hit-rate': 0.7,
    output: 'data/sample.csv',
    'seed-customers': true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = argv[i + 1];

      if (key === 'seed-customers') {
        params['seed-customers'] = true;
        continue;
      }

      if (nextArg && !nextArg.startsWith('--')) {
        const val = nextArg;
        if (key === 'rows' || key === 'hit-rate') {
          params[key] = parseFloat(val);
        } else {
          params[key] = val;
        }
        i++;
      } else {
        params[key] = true;
      }
    }
  }

  return params;
}

async function main() {
  const params = parseArgs(process.argv.slice(2));
  const db = getDb();

  try {
    await generateCsv(db, {
      rows: params['rows'] as number,
      hitRate: params['hit-rate'] as number,
      output: params['output'] as string,
      seedCustomers: params['seed-customers'] !== false,
      cycle: params['cycle'] as string | undefined,
      origin: params['origin'] as string | undefined,
    });
  } finally {
    closeDb();
  }
}

const isDirectRun = process.argv[1]?.includes('genCsv');

if (isDirectRun) {
  main().catch((err) => {
    log(`[genCsv] erro: ${err.message}`);
    process.exit(1);
  });
}
