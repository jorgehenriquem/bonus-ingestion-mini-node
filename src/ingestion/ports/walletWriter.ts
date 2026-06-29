export interface WalletWriterRow {
  id: string;
  walletId: string;
  amountCents: number;
  cycle: string;
  origin: string;
  cpf: string;
  expiresIn: string; // ISO datetime — obrigatório; padrão: now + 180 dias
}

export interface PreChargeRow {
  id: string;
  cpf: string;
  phone: string | null;
  amountCents: number;
  cycle: string;
  origin: string;
}

export interface WalletWriter {
  bulkCredit(rows: WalletWriterRow[]): void;
  bulkPreCharge(rows: PreChargeRow[]): void;
}
