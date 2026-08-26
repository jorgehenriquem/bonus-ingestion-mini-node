// stdout is reserved for the MCP JSON-RPC channel; all logging goes to stderr.
export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}
