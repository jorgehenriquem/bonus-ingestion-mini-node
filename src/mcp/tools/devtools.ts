import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { generateCsv } from '../../../tools/genCsv.ts';
import { config } from '../config.ts';
import { resolveSafePath, toRelative } from '../safety.ts';
import { ok, fail } from './result.ts';

export function registerDevTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    'generate_sample_csv',
    {
      title: 'Gerar CSV de volume',
      description:
        'Gera um CSV de bônus para demonstração e popula a tabela customer com a fração ' +
        'indicada por hitRate (os que já têm carteira e viram RECHARGE na ingestão). ' +
        'ATENÇÃO: limpa as tabelas customer e pre_charge antes de gerar.',
      inputSchema: {
        rows: z.number().int().min(1).max(config.maxRows).optional().describe('Default 100000'),
        hitRate: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Fração de CPFs com cadastro. Default 0.7'),
        output: z.string().optional().describe('Nome do arquivo dentro da raiz de dados'),
      },
      outputSchema: {
        filePath: z.string(),
        rows: z.number(),
        hitRate: z.number(),
        seededCustomers: z.number(),
        sizeBytes: z.number(),
        durationMs: z.number(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ rows, hitRate, output }) => {
      try {
        const target = resolveSafePath(output ?? 'sample.csv');

        const result = await generateCsv(db, {
          rows,
          hitRate,
          output: target,
          seedCustomers: true,
        });

        return ok({
          filePath: toRelative(result.filePath),
          rows: result.rows,
          hitRate: result.hitRate,
          seededCustomers: result.seededCustomers,
          sizeBytes: result.sizeBytes,
          durationMs: result.durationMs,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_data_root',
    {
      title: 'Raiz de dados do servidor',
      description:
        'Mostra a raiz onde os arquivos podem ser lidos e escritos, e os arquivos disponíveis nela. ' +
        'Use para descobrir o caminho a passar para start_ingestion.',
      inputSchema: {},
      outputSchema: {
        ingestRoot: z.string(),
        dbPath: z.string(),
        files: z.array(z.object({ name: z.string(), sizeBytes: z.number() })),
      },
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { readdir, stat } = await import('node:fs/promises');

      try {
        const names = await readdir(config.ingestRoot);
        const files = [];
        for (const name of names) {
          const info = await stat(path.join(config.ingestRoot, name));
          if (info.isFile()) files.push({ name, sizeBytes: info.size });
        }

        return ok({
          ingestRoot: config.ingestRoot,
          dbPath: process.env['DB_PATH'] ?? '(default do projeto)',
          files,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
