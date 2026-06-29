import { createWriteStream } from 'node:fs';
import { getDb, closeDb } from '../src/ingestion/infra/db.ts';

const args = process.argv.slice(2);

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
  const params = parseArgs(args);

  const rows = Math.floor(params['rows'] as number);
  const hitRate = Math.min(1, Math.max(0, params['hit-rate'] as number));
  const output = params['output'] as string;
  const seedCustomers = params['seed-customers'] !== false;

  console.log(`[genCsv] gerando ${rows.toLocaleString()} linhas (${(hitRate * 100).toFixed(1)}% hit-rate)`);
  console.log(`[genCsv] output: ${output}`);

  const db = getDb();
  const startMs = Date.now();

  try {
    // Limpar dados anteriores se houver
    db.prepare('DELETE FROM customer WHERE 1=1').run();
    db.prepare('DELETE FROM pre_charge WHERE 1=1').run();

    if (seedCustomers) {
      console.log('[genCsv] seeding customers...');

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

      // batch insert dos customers (hit)
      const batchSize = 5000;
      const cpfs: string[] = [];
      let phoneIdx = 0;
      for (let i = 0; i < hitCount; i++) {
        const cpf = String(i).padStart(11, '0');
        cpfs.push(cpf);
        if (cpfs.length >= batchSize) {
          transaction([cpfs, phoneIdx]);
          phoneIdx += cpfs.length;
          cpfs.length = 0;
        }
      }
      if (cpfs.length > 0) {
        transaction([cpfs, phoneIdx]);
      }

      console.log(`[genCsv] ${hitCount.toLocaleString()} customers criados`);
    }

    // Gerar CSV com stream
    const writer = createWriteStream(output, { encoding: 'utf-8' });

    console.log('[genCsv] escrevendo CSV...');

    writer.write('cpf,phone,amount,cycle,origin\n');

    let written = 0;
    let prevLogPercent = 0;

    for (let i = 0; i < rows; i++) {
      const cpf = String(i).padStart(11, '0');
      const phone = `119${String(Math.random()).slice(2, 10)}`;

      // amount aleatório entre 5.00 e 100.00
      const amount = (5 + Math.random() * 95).toFixed(2);

      const line = `${cpf},${phone},${amount},2026-06,vivo\n`;
      writer.write(line);

      written++;

      // log progress a cada 10%
      const percent = Math.floor((written / rows) * 100);
      if (percent >= prevLogPercent + 10) {
        const elapsed = (Date.now() - startMs) / 1000;
        const rps = elapsed > 0 ? Math.round(written / elapsed) : 0;
        console.log(`[genCsv] ${percent}% (${written.toLocaleString()}/${rows.toLocaleString()}) ${rps} r/s`);
        prevLogPercent = percent;
      }
    }

    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.on('error', reject);
    });

    const elapsed = (Date.now() - startMs) / 1000;
    const rps = Math.round(rows / elapsed);
    console.log(`[genCsv] concluído em ${elapsed.toFixed(1)}s (${rps} r/s)`);
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error('[genCsv] erro:', err.message);
  process.exit(1);
});
