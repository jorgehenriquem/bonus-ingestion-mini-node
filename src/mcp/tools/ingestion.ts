import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.ts';
import { resolveSafePath, toRelative, clampLimit } from '../safety.ts';
import { startIngestion, getJob, listJobs, cancelIngestion } from '../jobs.ts';
import type { Job } from '../jobs.ts';
import { ok, fail } from './result.ts';

const jobShape = {
  jobId: z.string(),
  filePath: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  read: z.number(),
  credited: z.number(),
  expired: z.number(),
  preCharged: z.number(),
  rejected: z.number(),
  rowsPerSec: z.number(),
  rssMb: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
};

function view(job: Job) {
  return { ...job, filePath: toRelative(job.filePath) };
}

export function registerIngestionTools(server: McpServer): void {
  server.registerTool(
    'start_ingestion',
    {
      title: 'Iniciar ingestão de CSV de bônus',
      description:
        'Inicia a ingestão de um CSV em background e devolve um jobId imediatamente. ' +
        'Acompanhe com get_ingestion_status — a ingestão pode levar minutos. ' +
        'É idempotente: reprocessar o mesmo arquivo não duplica crédito, e por padrão ' +
        'retoma do último lote confirmado (resume).',
      inputSchema: {
        filePath: z
          .string()
          .describe('Caminho do CSV relativo à raiz de dados, ex. "sample.csv"'),
        batchSize: z.number().int().min(1).max(10_000).optional(),
        resume: z.boolean().optional().describe('Default true — retoma do checkpoint'),
        expiredRate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Fração de créditos criados já vencidos. Default 0'),
      },
      outputSchema: jobShape,
    },
    async ({ filePath, batchSize, resume, expiredRate }) => {
      try {
        const resolved = resolveSafePath(filePath);
        const job = startIngestion({
          filePath: resolved,
          batchSize: batchSize ?? config.defaultBatchSize,
          resume: resume ?? true,
          expiredRate: expiredRate ?? 0,
        });
        return ok(view(job));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_ingestion_status',
    {
      title: 'Status da ingestão',
      description:
        'Snapshot de um job de ingestão. Enquanto status="running", os contadores avançam ' +
        'a cada 100 lotes. Sem jobId, lista os jobs mais recentes.',
      inputSchema: {
        jobId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        jobs: z.array(z.object(jobShape)),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId, limit }) => {
      if (jobId) {
        const job = getJob(jobId);
        if (!job) return fail(`job desconhecido: ${jobId}`);
        return ok({ jobs: [view(job)] });
      }

      return ok({ jobs: listJobs(clampLimit(limit, 10)).map(view) });
    },
  );

  server.registerTool(
    'cancel_ingestion',
    {
      title: 'Cancelar ingestão',
      description:
        'Pede o cancelamento de um job em andamento. O corte acontece entre lotes, então os ' +
        'lotes já confirmados permanecem e o checkpoint permite retomar depois de onde parou.',
      inputSchema: { jobId: z.string() },
      outputSchema: jobShape,
    },
    async ({ jobId }) => {
      try {
        return ok(view(cancelIngestion(jobId)));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
