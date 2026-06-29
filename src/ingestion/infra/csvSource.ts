import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';

export async function* csvRows(filePath: string): AsyncGenerator<Record<string, string>> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const parser = parse({
    columns: true,
    skip_empty_lines: true,
  });

  const pipelineStream = stream.pipe(parser);

  for await (const row of pipelineStream) {
    yield row;
  }
}
