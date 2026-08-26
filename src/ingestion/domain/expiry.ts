function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_EXPIRY_DAYS = envDays('BONUS_EXPIRY_DAYS', 180);

export const ALREADY_EXPIRED_DAYS = envDays('BONUS_ALREADY_EXPIRED_DAYS', -200);

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
