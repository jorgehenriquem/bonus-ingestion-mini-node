import path from 'node:path';
import { realpathSync } from 'node:fs';
import { config } from './config.ts';

export class SafetyError extends Error {}

export function resolveSafePath(userPath: string): string {
  if (!userPath || userPath.trim() === '') {
    throw new SafetyError('caminho vazio');
  }

  const root = config.ingestRoot;
  const resolved = path.resolve(root, userPath);

  if (!isInside(root, resolved)) {
    throw new SafetyError(
      `caminho fora da raiz permitida (${root}); use um caminho relativo a ela`,
    );
  }

  // A symlink inside the root can still point outside it.
  try {
    const real = realpathSync(resolved);
    if (!isInside(realpathSync(root), real)) {
      throw new SafetyError('caminho resolve para fora da raiz permitida');
    }
    return real;
  } catch (err) {
    if (err instanceof SafetyError) throw err;
    return resolved;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function clampLimit(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback;
  return Math.max(1, Math.min(config.listLimit, Math.floor(value)));
}

export function toRelative(absolutePath: string): string {
  const rel = path.relative(config.ingestRoot, absolutePath);
  return rel === '' ? absolutePath : rel.split(path.sep).join('/');
}
