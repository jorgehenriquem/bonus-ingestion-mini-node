import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import type { RejectSink } from '../ports/rejectSink.ts';
import { maskCpf } from '../domain/bonusRecord.ts';

export class FileRejectSink implements RejectSink {
  private writer: WriteStream;

  constructor(filePath: string) {
    this.writer = createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
  }

  write(line: Record<string, string>, reason: string): void {
    const maskedLine = {
      ...line,
      cpf: maskCpf(line['cpf'] ?? ''),
    };
    const jsonLine = JSON.stringify({ line: maskedLine, reason }) + '\n';
    this.writer.write(jsonLine);
  }

  close(): void {
    return new Promise<void>((resolve, reject) => {
      this.writer.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    }) as any;
  }
}
