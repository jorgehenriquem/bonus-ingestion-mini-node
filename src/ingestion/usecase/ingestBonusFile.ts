import path from 'node:path';
import type Database from 'better-sqlite3';
import { csvRows } from '../infra/csvSource.ts';
import { SqliteCustomerLookup } from '../infra/sqliteCustomerLookup.ts';
import { SqliteWalletWriter } from '../infra/sqliteWalletWriter.ts';
import { SqliteCheckpoint } from '../infra/sqliteCheckpoint.ts';
import { FileRejectSink } from '../infra/fileRejectSink.ts';
import { log } from '../infra/logger.ts';
import {
  daysFromNow,
  DEFAULT_EXPIRY_DAYS,
  ALREADY_EXPIRED_DAYS,
} from '../domain/expiry.ts';
import { parseBonusRow, maskCpf } from '../domain/bonusRecord.ts';
import { decideCreditPolicy } from '../domain/creditPolicy.ts';
import type { BonusRecord } from '../domain/bonusRecord.ts';
import type { WalletWriterRow, PreChargeRow } from '../ports/walletWriter.ts';

export type IngestOptions = {
  filePath: string;
  batchSize?: number;
  resume?: boolean;
  rejectFilePath?: string;
  maxConsecutiveErrors?: number;
  expiredRate?: number; // 0..1 — fração de RECHARGEs criados já vencidos (expires_in 200 dias atrás)
  onProgress?: (snapshot: IngestProgress) => void;
  shouldCancel?: () => boolean;
};

export type IngestProgress = {
  batchNo: number;
  read: number;
  credited: number;
  expired: number;
  preCharged: number;
  rejected: number;
  rowsPerSec: number;
  rssMb: number;
};

export type IngestReport = {
  read: number;
  credited: number;
  expired: number; // subset de credited: criados já vencidos
  preCharged: number;
  rejected: number;
  durationMs: number;
  rowsPerSec: number;
  cancelled: boolean;
};

export async function ingestBonusFile(
  db: Database.Database,
  opts: IngestOptions,
): Promise<IngestReport> {
  const {
    filePath,
    batchSize = 500,
    resume = true,
    rejectFilePath = filePath + '.rejected.jsonl',
    maxConsecutiveErrors = 3,
    expiredRate = 0,
    onProgress,
    shouldCancel,
  } = opts;

  const defaultExpiresIn = daysFromNow(DEFAULT_EXPIRY_DAYS);
  const alreadyExpiredAt = daysFromNow(ALREADY_EXPIRED_DAYS);

  const fileKey = path.basename(filePath);
  const lookup = new SqliteCustomerLookup(db);
  const writer = new SqliteWalletWriter(db);
  const checkpoint = new SqliteCheckpoint(db);
  const rejectSink = new FileRejectSink(rejectFilePath);

  const lastBatch = resume ? checkpoint.load(fileKey) : 0;

  let read = 0;
  let credited = 0;
  let expired = 0;
  let preCharged = 0;
  let rejected = 0;
  let batchNo = 0;
  let consecutiveErrors = 0;
  let batch: BonusRecord[] = [];

  const startMs = performance.now();

  // Log memory periodically (every 100 batches)
  let logTick = 0;

  const flushBatch = () => {
    batchNo++;

    if (batchNo <= lastBatch) {
      batch = [];
      return;
    }

    const currentBatch = batch;
    batch = [];

    const keys = currentBatch.map((r) => r.cpf);
    const walletMap = lookup.findWalletsByKeys(keys);

    const rechargeRows: WalletWriterRow[] = [];
    const preChargeRows: PreChargeRow[] = [];

    for (const record of currentBatch) {
      const walletId = walletMap.get(record.cpf);
      const decision = decideCreditPolicy(record, walletId);

      if (decision.type === 'RECHARGE') {
        const isExpired = expiredRate > 0 && Math.random() < expiredRate;
        rechargeRows.push({
          // PK determinística: elimina duplicação mesmo se checkpoint falhar antes de ser salvo
          id: `${record.origin}:${record.cycle}:${record.cpf}`,
          walletId: decision.walletId,
          amountCents: record.amountCents,
          cycle: record.cycle,
          origin: record.origin,
          cpf: record.cpf,
          expiresIn: isExpired ? alreadyExpiredAt : defaultExpiresIn,
        });
      } else {
        preChargeRows.push({
          id: `${record.origin}:${record.cycle}:${record.cpf}`,
          cpf: record.cpf,
          phone: record.phone,
          amountCents: record.amountCents,
          cycle: record.cycle,
          origin: record.origin,
        });
      }
    }

    // Checkpoint atômico com o write — elimina a janela de crash entre write e save
    db.transaction(() => {
      writer.bulkCredit(rechargeRows);
      writer.bulkPreCharge(preChargeRows);
      checkpoint.save(fileKey, batchNo);
    })();

    credited += rechargeRows.length;
    expired += rechargeRows.filter((r) => new Date(r.expiresIn) < new Date()).length;
    preCharged += preChargeRows.length;

    logTick++;
    if (logTick % 100 === 0) {
      const elapsed = (performance.now() - startMs) / 1000;
      const rps = elapsed > 0 ? Math.round(read / elapsed) : 0;
      const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      log(
        `[ingest] lote=${batchNo} lido=${read} creditado=${credited} pre=${preCharged} rej=${rejected} ${rps}r/s mem=${rss}MB`,
      );
      onProgress?.({ batchNo, read, credited, expired, preCharged, rejected, rowsPerSec: rps, rssMb: rss });
    }
  };

  let cancelled = false;

  try {
    for await (const row of csvRows(filePath)) {
      if (batch.length === 0 && shouldCancel?.()) {
        cancelled = true;
        break;
      }

      read++;
      const result = parseBonusRow(row);

      if (!result.ok) {
        rejectSink.write(row, result.reason);
        rejected++;
        continue;
      }

      batch.push(result.record);

      if (batch.length >= batchSize) {
        try {
          flushBatch();
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          const msg = err instanceof Error ? err.message : String(err);
          log(`[ingest] erro no lote ${batchNo + 1}: ${msg}`);
          if (consecutiveErrors >= maxConsecutiveErrors) {
            throw new Error(
              `Abortando: ${consecutiveErrors} erros consecutivos. Último: ${msg}`,
            );
          }
          batch = []; // descarta lote falho
        }
      }
    }

    // lote final (sobra)
    if (batch.length > 0) {
      try {
        flushBatch();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[ingest] erro no lote final: ${msg}`);
        // lote final não aborta — só loga
      }
    }
  } finally {
    rejectSink.close();
  }

  const durationMs = performance.now() - startMs;
  const rowsPerSec = durationMs > 0 ? Math.round((read / durationMs) * 1000) : 0;

  const report: IngestReport = {
    read,
    credited,
    expired,
    preCharged,
    rejected,
    durationMs,
    rowsPerSec,
    cancelled,
  };
  log(`[ingest] concluído: ${JSON.stringify(report)}`);

  return report;
}

export function buildFileKey(filePath: string): string {
  return path.basename(filePath);
}

export { daysFromNow };

// Mascara CPF para uso em mensagens de erro (re-exporta para conveniência)
export { maskCpf };
