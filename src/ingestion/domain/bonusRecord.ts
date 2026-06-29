export type BonusRecord = {
  cpf: string;
  phone: string | null;
  amountCents: number;
  cycle: string;
  origin: string;
};

export type ParseResult =
  | { ok: true; record: BonusRecord }
  | { ok: false; reason: string };

const CPF_RE = /^\d{11}$/;
const CYCLE_RE = /^\d{4}-\d{2}$/;

export function parseBonusRow(raw: Record<string, string>): ParseResult {
  const cpf = (raw['cpf'] ?? '').trim().replace(/\D/g, '');
  const phone = (raw['phone'] ?? '').trim() || null;
  const amountRaw = (raw['amount'] ?? '').trim();
  const cycle = (raw['cycle'] ?? '').trim();
  const origin = (raw['origin'] ?? '').trim();

  if (!CPF_RE.test(cpf)) {
    return { ok: false, reason: `cpf inválido: "${maskCpf(raw['cpf'] ?? '')}"` };
  }
  if (!CYCLE_RE.test(cycle)) {
    return { ok: false, reason: `cycle inválido: "${cycle}"` };
  }
  if (!origin) {
    return { ok: false, reason: 'origin vazio' };
  }

  const amountFloat = parseFloat(amountRaw);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    return { ok: false, reason: `amount inválido: "${amountRaw}"` };
  }

  const amountCents = Math.round(amountFloat * 100);

  return { ok: true, record: { cpf, phone, amountCents, cycle, origin } };
}

export function maskCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, '');
  if (d.length !== 11) return '***.***.***-**';
  return `${d.slice(0, 3)}.***.**${d.slice(8, 9)}-${d.slice(9)}`;
}
