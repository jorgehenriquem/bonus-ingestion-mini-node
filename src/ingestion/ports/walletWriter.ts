export interface WalletWriterRow {
  id: string;
  walletId: string;
  amountCents: number;
  cycle: string;
  origin: string;
  cpf: string;
  expiresIn?: string | null; // ISO datetime; null = sem vencimento
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
