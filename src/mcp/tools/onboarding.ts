import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { registerCustomer } from '../../ingestion/usecase/registerCustomer.ts';
import { maskCpf } from '../../ingestion/domain/bonusRecord.ts';
import { ok, fail } from './result.ts';

export function registerOnboardingTools(server: McpServer, db: Database.Database): void {
  server.registerTool(
    'register_customer',
    {
      title: 'Cadastrar cliente e converter pré-recargas',
      description:
        'Cria (ou atualiza) o cadastro do CPF e converte todas as pré-recargas PENDING dele ' +
        'em crédito na carteira, numa única transação. É o fluxo de onboarding do case: ' +
        'quem não tinha cadastro recebe o bônus retroativo.',
      inputSchema: {
        cpf: z.string().regex(/^\d{11}$/).describe('CPF com 11 dígitos, sem pontuação'),
        phone: z.string().optional(),
        walletId: z.string().optional().describe('Se omitido, deriva do CPF'),
      },
      outputSchema: {
        cpf: z.string(),
        walletId: z.string(),
        redeemed: z.number(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ cpf, phone, walletId }) => {
      try {
        const result = registerCustomer(db, {
          cpf,
          phone: phone ?? null,
          walletId: walletId ?? null,
        });

        return ok({
          cpf: maskCpf(result.cpf),
          walletId: result.walletId,
          redeemed: result.redeemed,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
