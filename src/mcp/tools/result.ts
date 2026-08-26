export function ok<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function fail(message: string) {
  return {
    content: [{ type: 'text' as const, text: `erro: ${message}` }],
    isError: true,
  };
}
