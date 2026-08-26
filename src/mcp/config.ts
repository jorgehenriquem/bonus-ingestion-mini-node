import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  projectRoot,
  serverName: process.env['MCP_SERVER_NAME'] ?? 'bonus-ingestion',
  serverVersion: process.env['MCP_SERVER_VERSION'] ?? '1.0.0',
  ingestRoot: path.resolve(process.env['INGEST_ROOT'] ?? path.join(projectRoot, 'data')),
  defaultBatchSize: num('INGEST_BATCH_SIZE', 500),
  maxRows: num('MCP_MAX_GENERATED_ROWS', 10_000_000),
  listLimit: num('MCP_LIST_LIMIT', 100),
  maxConcurrentIngestions: num('MCP_MAX_CONCURRENT_INGESTIONS', 1),
};
