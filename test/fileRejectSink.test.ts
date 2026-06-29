import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileRejectSink } from '../src/ingestion/infra/fileRejectSink.ts';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('FileRejectSink', () => {
  let testFile: string;

  beforeEach(() => {
    testFile = join(process.cwd(), 'test-reject-sink.jsonl');
  });

  afterEach(() => {
    try {
      unlinkSync(testFile);
    } catch {
      // ignore
    }
  });

  it('should write rejected lines to file with reason', (done) => {
    const sink = new FileRejectSink(testFile);

    sink.write(
      {
        cpf: '12345678901',
        phone: '11999990000',
        amount: 'invalid',
        cycle: '2026-06',
        origin: 'vivo',
      },
      'amount inválido: "invalid"',
    );

    sink.close();

    setTimeout(() => {
      const content = readFileSync(testFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed).toHaveProperty('reason', 'amount inválido: "invalid"');
      expect(parsed).toHaveProperty('line');
      expect(parsed.line).toHaveProperty('cpf');
      expect(parsed.line.cpf).not.toContain('12345678901');
      done();
    }, 100);
  });

  it('should mask cpf in rejected lines', (done) => {
    const sink = new FileRejectSink(testFile);

    sink.write(
      {
        cpf: '12345678901',
        phone: '11999990000',
        amount: '-50',
        cycle: '2026-06',
        origin: 'vivo',
      },
      'amount inválido: "-50"',
    );

    sink.close();

    setTimeout(() => {
      const content = readFileSync(testFile, 'utf-8');
      const parsed = JSON.parse(content.trim().split('\n')[0]);
      expect(parsed.line.cpf).toMatch(/^\d{3}\.\*{3}\.\*{2}\d-\d{2}$/);
      done();
    }, 100);
  });

  it('should append multiple rejected lines', (done) => {
    const sink = new FileRejectSink(testFile);

    sink.write(
      { cpf: '12345678901', phone: '11999990000', amount: '-50', cycle: '2026-06', origin: 'vivo' },
      'amount inválido',
    );
    sink.write(
      { cpf: 'invalid', phone: '11999990000', amount: '50', cycle: '2026-06', origin: 'vivo' },
      'cpf inválido',
    );

    sink.close();

    setTimeout(() => {
      const content = readFileSync(testFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      done();
    }, 100);
  });
});
