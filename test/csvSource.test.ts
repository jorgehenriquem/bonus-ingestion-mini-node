import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { csvRows } from '../src/ingestion/infra/csvSource.ts';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('csvSource', () => {
  let testFile: string;

  beforeEach(() => {
    testFile = join(process.cwd(), 'test-csv-source.csv');
  });

  afterEach(() => {
    try {
      unlinkSync(testFile);
    } catch {
      // ignore
    }
  });

  it('should read CSV file with csvRows generator', async () => {
    const csv = `cpf,phone,amount,cycle,origin
12345678901,11999990000,50.00,2026-06,vivo
11111111111,11988880000,100.00,2026-06,vivo
22222222222,11977770000,75.50,2026-06,vivo
33333333333,11966660000,25.25,2026-06,vivo
44444444444,11955550000,150.00,2026-06,vivo`;

    writeFileSync(testFile, csv, 'utf-8');

    const rows: Record<string, string>[] = [];
    for await (const row of csvRows(testFile)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      cpf: '12345678901',
      phone: '11999990000',
      amount: '50.00',
      cycle: '2026-06',
      origin: 'vivo',
    });
    expect(rows[4]).toEqual({
      cpf: '44444444444',
      phone: '11955550000',
      amount: '150.00',
      cycle: '2026-06',
      origin: 'vivo',
    });
  });

  it('should handle empty lines gracefully', async () => {
    const csv = `cpf,phone,amount,cycle,origin
12345678901,11999990000,50.00,2026-06,vivo

11111111111,11988880000,100.00,2026-06,vivo`;

    writeFileSync(testFile, csv, 'utf-8');

    const rows: Record<string, string>[] = [];
    for await (const row of csvRows(testFile)) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
  });
});
