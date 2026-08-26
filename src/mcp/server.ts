import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDb, closeDb } from '../ingestion/infra/db.ts';
import { log } from '../ingestion/infra/logger.ts';
import { config } from './config.ts';
import { shutdownJobs } from './jobs.ts';
import { registerReportingTools } from './tools/reporting.ts';
import { registerOnboardingTools } from './tools/onboarding.ts';
import { registerDevTools } from './tools/devtools.ts';
import { registerIngestionTools } from './tools/ingestion.ts';

const SHUTDOWN_GRACE_MS = 250;

export function buildServer(db = getDb()): McpServer {
  const server = new McpServer({
    name: config.serverName,
    version: config.serverVersion,
  });

  registerReportingTools(server, db);
  registerOnboardingTools(server, db);
  registerDevTools(server, db);
  registerIngestionTools(server);

  return server;
}

async function main() {
  // Long-lived process: the connection is opened once and closed only on shutdown.
  const db = getDb();
  const server = buildServer(db);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownJobs();
    closeDb();
    // Grace window so a tool call already in flight can still write its response.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // The client closing stdin ends the session; without this the process (and its
  // container, under `docker run -i --rm`) lingers. Must be set after connect():
  // connect() installs the SDK's own transport.onclose over anything set earlier.
  await server.connect(new StdioServerTransport());
  server.server.onclose = shutdown;
  log(`[mcp] ${config.serverName} v${config.serverVersion} pronto (raiz: ${config.ingestRoot})`);
}

const isDirectRun = process.argv[1]?.includes('server');

if (isDirectRun) {
  main().catch((err) => {
    log(`[mcp] falha ao iniciar: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
