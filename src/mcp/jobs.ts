import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.ts';
import { log } from '../ingestion/infra/logger.ts';
import type { IngestProgress, IngestReport } from '../ingestion/usecase/ingestBonusFile.ts';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type Job = {
  jobId: string;
  filePath: string;
  status: JobStatus;
  read: number;
  credited: number;
  expired: number;
  preCharged: number;
  rejected: number;
  rowsPerSec: number;
  rssMb: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
};

export type StartOptions = {
  filePath: string;
  batchSize?: number;
  resume?: boolean;
  expiredRate?: number;
};

const jobs = new Map<string, Job>();
const children = new Map<string, ChildProcess>();

const tsxCli = path.join(config.projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const childScript = path.join(config.projectRoot, 'src', 'mcp', 'ingestionChild.ts');

export class JobError extends Error {}

export function startIngestion(opts: StartOptions): Job {
  const running = [...jobs.values()].filter((j) => j.status === 'running');
  if (running.length >= config.maxConcurrentIngestions) {
    throw new JobError(
      `já existe ingestão em andamento (jobId=${running[0].jobId}); acompanhe com get_ingestion_status`,
    );
  }

  const jobId = randomUUID().slice(0, 8);
  const job: Job = {
    jobId,
    filePath: opts.filePath,
    status: 'running',
    read: 0,
    credited: 0,
    expired: 0,
    preCharged: 0,
    rejected: 0,
    rowsPerSec: 0,
    rssMb: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    error: null,
  };
  jobs.set(jobId, job);

  const child = spawn(process.execPath, [tsxCli, childScript, JSON.stringify(opts)], {
    cwd: config.projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  children.set(jobId, child);

  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (!line.trim()) return;
    try {
      handleChildMessage(job, JSON.parse(line));
    } catch {
      log(`[jobs] linha não reconhecida do job ${jobId}: ${line.slice(0, 200)}`);
    }
  });

  createInterface({ input: child.stderr! }).on('line', (line) => {
    log(`[job:${jobId}] ${line}`);
  });

  child.on('close', (code) => {
    children.delete(jobId);
    if (job.status !== 'running') return;

    if (code === 0) {
      job.status = 'done';
    } else {
      job.status = 'failed';
      job.error = job.error ?? `processo terminou com código ${code}`;
    }
    job.finishedAt = new Date().toISOString();
  });

  return job;
}

function handleChildMessage(job: Job, message: { type: string; [k: string]: unknown }): void {
  if (message['type'] === 'progress') {
    const s = message['snapshot'] as IngestProgress;
    Object.assign(job, {
      read: s.read,
      credited: s.credited,
      expired: s.expired,
      preCharged: s.preCharged,
      rejected: s.rejected,
      rowsPerSec: s.rowsPerSec,
      rssMb: s.rssMb,
    });
    return;
  }

  if (message['type'] === 'done') {
    const r = message['report'] as IngestReport;
    Object.assign(job, {
      read: r.read,
      credited: r.credited,
      expired: r.expired,
      preCharged: r.preCharged,
      rejected: r.rejected,
      rowsPerSec: r.rowsPerSec,
      durationMs: Math.round(r.durationMs),
      status: r.cancelled ? 'cancelled' : 'done',
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  if (message['type'] === 'error') {
    Object.assign(job, {
      status: 'failed',
      error: String(message['message']),
      finishedAt: new Date().toISOString(),
    });
  }
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

export function listJobs(limit: number): Job[] {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

export function cancelIngestion(jobId: string): Job {
  const job = jobs.get(jobId);
  if (!job) throw new JobError(`job desconhecido: ${jobId}`);
  if (job.status !== 'running') return job;

  const child = children.get(jobId);
  child?.stdin?.write('cancel\n');
  return job;
}

export function shutdownJobs(): void {
  for (const child of children.values()) {
    child.kill();
  }
}
