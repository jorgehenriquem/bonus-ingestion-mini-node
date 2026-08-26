import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { maskCpf } from '../../ingestion/domain/bonusRecord.ts';
import { resolveSafePath, clampLimit, toRelative } from '../safety.ts';
import { ok, fail } from './result.ts';

export function registerReportingTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    'get_wallet_summary',
    {
      title: 'Resumo das carteiras',
      description:
        'Totais agregados de créditos (RECHARGE) e pré-recargas no banco. ' +
        'Filtre por cycle (ex. "2026-06") e origin (ex. "vivo") para ver um lote específico.',
      inputSchema: {
        cycle: z.string().optional().describe('Ciclo mensal, formato YYYY-MM'),
        origin: z.string().optional().describe('Origem do arquivo, ex. "vivo"'),
      },
      outputSchema: {
        recharges: z.number(),
        totalCents: z.number(),
        expiredCount: z.number(),
        preChargesPending: z.number(),
        preChargesRedeemed: z.number(),
        preChargesPendingCents: z.number(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cycle, origin }) => {
      const filters: string[] = [];
      const params: Record<string, string> = { now: new Date().toISOString() };

      if (cycle) {
        filters.push('cycle = @cycle');
        params['cycle'] = cycle;
      }
      if (origin) {
        filters.push('origin = @origin');
        params['origin'] = origin;
      }
      const and = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
      const where = filters.length > 0 ? ` WHERE ${filters.join(' AND ')}` : '';

      const credits = db
        .prepare(`
          SELECT
            COUNT(*) AS recharges,
            COALESCE(SUM(amount), 0) AS totalCents,
            COALESCE(SUM(CASE WHEN expires_in IS NOT NULL AND expires_in < @now THEN 1 ELSE 0 END), 0) AS expiredCount
          FROM wallet_transaction
          WHERE type = 'RECHARGE'${and}
        `)
        .get(params) as { recharges: number; totalCents: number; expiredCount: number };

      const preRows = db
        .prepare(`
          SELECT status, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS cents
          FROM pre_charge${where}
          GROUP BY status
        `)
        .all(params) as Array<{ status: string; n: number; cents: number }>;

      const pending = preRows.find((r) => r.status === 'PENDING');
      const redeemed = preRows.find((r) => r.status === 'REDEEMED');

      return ok({
        recharges: credits.recharges,
        totalCents: credits.totalCents,
        expiredCount: credits.expiredCount,
        preChargesPending: pending?.n ?? 0,
        preChargesRedeemed: redeemed?.n ?? 0,
        preChargesPendingCents: pending?.cents ?? 0,
      });
    },
  );

  server.registerTool(
    'lookup_customer',
    {
      title: 'Consultar cliente',
      description:
        'Verifica se um CPF ou telefone tem cadastro e quantas pré-recargas pendentes possui. ' +
        'O CPF nunca é devolvido em claro.',
      inputSchema: {
        cpf: z.string().regex(/^\d{11}$/).optional().describe('CPF com 11 dígitos, sem pontuação'),
        phone: z.string().optional().describe('Telefone, alternativa ao CPF'),
      },
      outputSchema: {
        found: z.boolean(),
        cpf: z.string().nullable(),
        walletId: z.string().nullable(),
        recharges: z.number(),
        pendingPreCharges: z.number(),
        pendingCents: z.number(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cpf, phone }) => {
      if (!cpf && !phone) {
        return fail('informe cpf ou phone');
      }

      const customer = cpf
        ? (db.prepare('SELECT cpf, wallet_id FROM customer WHERE cpf = ?').get(cpf) as
            | { cpf: string; wallet_id: string }
            | undefined)
        : (db.prepare('SELECT cpf, wallet_id FROM customer WHERE phone = ?').get(phone!) as
            | { cpf: string; wallet_id: string }
            | undefined);

      const targetCpf = customer?.cpf ?? cpf ?? null;

      const pre = targetCpf
        ? (db
            .prepare(`
              SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS cents
              FROM pre_charge WHERE cpf = ? AND status = 'PENDING'
            `)
            .get(targetCpf) as { n: number; cents: number })
        : { n: 0, cents: 0 };

      const recharges = customer
        ? (db
            .prepare(`SELECT COUNT(*) AS n FROM wallet_transaction WHERE wallet_id = ? AND type = 'RECHARGE'`)
            .get(customer.wallet_id) as { n: number }).n
        : 0;

      return ok({
        found: Boolean(customer),
        cpf: targetCpf ? maskCpf(targetCpf) : null,
        walletId: customer?.wallet_id ?? null,
        recharges,
        pendingPreCharges: pre.n,
        pendingCents: pre.cents,
      });
    },
  );

  server.registerTool(
    'list_rejected_rows',
    {
      title: 'Listar linhas rejeitadas',
      description:
        'Lê o arquivo de dead-letter (<arquivo>.rejected.jsonl) gerado pela ingestão e ' +
        'devolve os primeiros motivos de rejeição, com o total.',
      inputSchema: {
        filePath: z
          .string()
          .describe('Caminho do CSV ingerido, relativo à raiz de dados (ex. "sample.csv")'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        filePath: z.string(),
        total: z.number(),
        returned: z.number(),
        rows: z.array(z.object({ reason: z.string(), cpf: z.string() })),
        reasonCounts: z.record(z.string(), z.number()),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filePath, limit }) => {
      const max = clampLimit(limit, 20);

      let rejectPath: string;
      try {
        const resolved = resolveSafePath(filePath);
        rejectPath = resolved.endsWith('.rejected.jsonl')
          ? resolved
          : `${resolved}.rejected.jsonl`;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      const rows: Array<{ reason: string; cpf: string }> = [];
      const reasonCounts: Record<string, number> = {};
      let total = 0;

      try {
        const stream = createReadStream(rejectPath, { encoding: 'utf-8' });
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          total++;

          let reason = 'desconhecido';
          let cpf = '***.***.***-**';
          try {
            const parsed = JSON.parse(line) as { reason?: string; line?: { cpf?: string } };
            reason = parsed.reason ?? reason;
            cpf = parsed.line?.cpf ?? cpf;
          } catch {
            reason = 'linha ilegível no arquivo de rejeição';
          }

          const key = reason.replace(/"[^"]*"/g, '"…"');
          reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;

          if (rows.length < max) rows.push({ reason, cpf });
        }
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') {
          return ok({
            filePath: toRelative(rejectPath),
            total: 0,
            returned: 0,
            rows: [],
            reasonCounts: {},
          });
        }
        return fail(e.message);
      }

      return ok({
        filePath: toRelative(rejectPath),
        total,
        returned: rows.length,
        rows,
        reasonCounts,
      });
    },
  );
}
