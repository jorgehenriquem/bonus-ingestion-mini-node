export { csvRows } from './infra/csvSource.ts';
export type { CustomerLookup } from './ports/customerLookup.ts';
export type { WalletWriter, WalletWriterRow, PreChargeRow } from './ports/walletWriter.ts';
export type { CheckpointStore } from './ports/checkpointStore.ts';
export type { RejectSink } from './ports/rejectSink.ts';

export { SqliteCustomerLookup } from './infra/sqliteCustomerLookup.ts';
export { SqliteWalletWriter } from './infra/sqliteWalletWriter.ts';
export { SqliteCheckpoint } from './infra/sqliteCheckpoint.ts';
export { FileRejectSink } from './infra/fileRejectSink.ts';

export { parseBonusRow, maskCpf, type BonusRecord, type ParseResult } from './domain/bonusRecord.ts';
export { decideCreditPolicy, type CreditDecision } from './domain/creditPolicy.ts';
export { getDb, closeDb } from './infra/db.ts';
