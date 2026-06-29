export interface CheckpointStore {
  load(fileKey: string): number;
  save(fileKey: string, batchNo: number): void;
}
