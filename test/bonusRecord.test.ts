import { describe, it, expect } from 'vitest';
import { parseBonusRow, maskCpf } from '../src/ingestion/domain/bonusRecord.ts';

describe('parseBonusRow', () => {
  const valid = { cpf: '12345678901', phone: '11999990000', amount: '50.00', cycle: '2026-06', origin: 'vivo' };

  it('linha válida vira BonusRecord', () => {
    const r = parseBonusRow(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.cpf).toBe('12345678901');
    expect(r.record.amountCents).toBe(5000);
    expect(r.record.cycle).toBe('2026-06');
    expect(r.record.origin).toBe('vivo');
    expect(r.record.phone).toBe('11999990000');
  });

  it('cpf curto é rejeitado', () => {
    const r = parseBonusRow({ ...valid, cpf: '1234' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cpf/i);
  });

  it('cpf com letras é rejeitado', () => {
    const r = parseBonusRow({ ...valid, cpf: '1234567890A' });
    expect(r.ok).toBe(false);
  });

  it('amount zero é rejeitado', () => {
    const r = parseBonusRow({ ...valid, amount: '0' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/amount/i);
  });

  it('amount negativo é rejeitado', () => {
    const r = parseBonusRow({ ...valid, amount: '-10' });
    expect(r.ok).toBe(false);
  });

  it('cycle com formato errado é rejeitado', () => {
    const r = parseBonusRow({ ...valid, cycle: '06-2026' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/cycle/i);
  });

  it('origin vazio é rejeitado', () => {
    const r = parseBonusRow({ ...valid, origin: '' });
    expect(r.ok).toBe(false);
  });

  it('phone vazio fica null', () => {
    const r = parseBonusRow({ ...valid, phone: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.phone).toBeNull();
  });

  it('amount em reais é convertido para centavos', () => {
    const r = parseBonusRow({ ...valid, amount: '12.34' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.amountCents).toBe(1234);
  });

  it('CPF com pontuação é normalizado', () => {
    const r = parseBonusRow({ ...valid, cpf: '123.456.789-01' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.cpf).toBe('12345678901');
  });
});

describe('maskCpf', () => {
  it('mascara CPF mantendo início e fim visíveis', () => {
    expect(maskCpf('12345678901')).toBe('123.***.**9-01');
  });
  it('CPF inválido retorna placeholder', () => {
    expect(maskCpf('abc')).toBe('***.***.***-**');
  });
});
