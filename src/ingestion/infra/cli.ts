import { getDb, closeDb } from './db.ts';
import { ingestBonusFile } from '../usecase/ingestBonusFile.ts';
import { redeemPreCharge } from '../usecase/redeemPreCharge.ts';

function printUsage() {
  console.log(`Uso:
  npx tsx src/ingestion/infra/cli.ts ingest <arquivo> [--no-resume] [--batch-size N]
  npx tsx src/ingestion/infra/cli.ts redeem <cpf>`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const params: Record<string, string | number | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = argv[i + 1];

      if (key === 'no-resume') {
        params['no-resume'] = true;
        continue;
      }

      if (nextArg && !nextArg.startsWith('--')) {
        const val = nextArg;
        if (key === 'batch-size') {
          params[key] = parseInt(val, 10);
        } else {
          params[key] = val;
        }
        i++;
      } else {
        params[key] = true;
      }
    } else if (!params['_command']) {
      params['_command'] = arg;
    } else if (!params['_arg1']) {
      params['_arg1'] = arg;
    }
  }

  return params;
}

async function handleIngest(filePath: string, opts: Record<string, string | number | boolean>) {
  const db = getDb();
  try {
    const batchSize = opts['batch-size'] ? (opts['batch-size'] as number) : 500;
    const resume = !opts['no-resume'];

    console.log(`[ingest] iniciando processamento: ${filePath}`);
    console.log(`[ingest] resume=${resume}, batch-size=${batchSize}`);

    const report = await ingestBonusFile(db, {
      filePath,
      batchSize,
      resume,
    });

    console.log('\n[ingest] RELATÓRIO FINAL:');
    console.log(`  Lidas:       ${report.read.toLocaleString()}`);
    console.log(`  Creditadas:  ${report.credited.toLocaleString()}`);
    console.log(`  Pré-recarga: ${report.preCharged.toLocaleString()}`);
    console.log(`  Rejeitadas:  ${report.rejected.toLocaleString()}`);
    console.log(`  Duração:     ${(report.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Throughput:  ${report.rowsPerSec.toLocaleString()} r/s`);
  } finally {
    closeDb();
  }
}

async function handleRedeem(cpf: string) {
  const db = getDb();
  try {
    console.log(`[redeem] processando CPF: ${cpf}`);

    const result = redeemPreCharge(db, cpf);

    console.log(`[redeem] concluído: ${result.redeemed} pré-cargas convertidas`);
  } finally {
    closeDb();
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printUsage();
  }

  const command = argv[0];
  const opts = parseArgs(argv.slice(1));

  try {
    if (command === 'ingest') {
      const filePath = opts['_command'] as string;
      if (!filePath) {
        console.error('[cli] erro: arquivo não fornecido');
        printUsage();
      }
      await handleIngest(filePath, opts);
    } else if (command === 'redeem') {
      const cpf = opts['_command'] as string;
      if (!cpf) {
        console.error('[cli] erro: CPF não fornecido');
        printUsage();
      }
      await handleRedeem(cpf);
    } else {
      console.error(`[cli] comando desconhecido: ${command}`);
      printUsage();
    }
  } catch (err) {
    console.error('[cli] erro:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[cli] erro não tratado:', err);
  process.exit(1);
});
