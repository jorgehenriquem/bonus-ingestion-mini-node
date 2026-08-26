import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveSafePath, clampLimit, toRelative, SafetyError } from '../src/mcp/safety.ts';
import { config } from '../src/mcp/config.ts';

describe('resolveSafePath', () => {
  it('aceita caminho relativo dentro da raiz', () => {
    const resolved = resolveSafePath('sample.csv');
    expect(resolved).toBe(path.join(config.ingestRoot, 'sample.csv'));
  });

  it('aceita subdiretório dentro da raiz', () => {
    const resolved = resolveSafePath('lote/2026-06.csv');
    expect(resolved.startsWith(config.ingestRoot)).toBe(true);
  });

  it('rejeita path traversal', () => {
    expect(() => resolveSafePath('../../etc/passwd')).toThrow(SafetyError);
  });

  it('rejeita traversal disfarçado no meio do caminho', () => {
    expect(() => resolveSafePath('lote/../../../secrets.env')).toThrow(SafetyError);
  });

  it('rejeita caminho absoluto fora da raiz', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    expect(() => resolveSafePath(outside)).toThrow(SafetyError);
  });

  it('rejeita caminho vazio', () => {
    expect(() => resolveSafePath('   ')).toThrow(SafetyError);
  });
});

describe('clampLimit', () => {
  it('usa o fallback quando não informado', () => {
    expect(clampLimit(undefined, 20)).toBe(20);
  });

  it('respeita o teto global', () => {
    expect(clampLimit(9999, 20)).toBe(config.listLimit);
  });

  it('nunca devolve menos de 1', () => {
    expect(clampLimit(0, 20)).toBe(1);
  });
});

describe('toRelative', () => {
  it('devolve caminho relativo à raiz com separador posix', () => {
    expect(toRelative(path.join(config.ingestRoot, 'sample.csv'))).toBe('sample.csv');
  });
});
