export interface RejectSink {
  write(line: Record<string, string>, reason: string): void;
  close(): void;
}
