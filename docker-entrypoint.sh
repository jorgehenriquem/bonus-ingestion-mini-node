#!/usr/bin/env sh
set -e

TSX="/app/node_modules/.bin/tsx"
CLI="src/ingestion/infra/cli.ts"

usage() {
  cat <<'EOF'
bonus-ingestion — comandos disponíveis no container

  gencsv [--rows N] [--hit-rate R] [--output PATH]
        Gera CSV de volume em /app/data (default: data/sample.csv)

  ingest <arquivo> [--no-resume] [--batch-size N] [--expired-rate R]
        Roda o pipeline de ingestão e imprime o relatório

  register <cpf> [--phone PHONE] [--wallet-id ID]
        Cadastra o cliente e converte as pré-recargas pendentes

  redeem <cpf>
        Converte pré-recargas pendentes em crédito

  mcp
        Inicia o servidor MCP em stdio (usado pelo Claude Cowork)

  test
        Roda a suíte Vitest dentro do container

  up
        Mantém o container vivo para `docker exec`

  shell
        Abre um shell dentro do container

Exemplos:
  docker run --rm -v bonus-data:/app/data bonus-ingestion gencsv --rows 200000
  docker run --rm -v bonus-data:/app/data --memory=256m bonus-ingestion ingest data/sample.csv
EOF
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  gencsv)
    exec "$TSX" tools/genCsv.ts "$@"
    ;;
  ingest|register|redeem)
    exec "$TSX" "$CLI" "$cmd" "$@"
    ;;
  mcp)
    exec "$TSX" src/mcp/server.ts "$@"
    ;;
  test)
    exec npm test
    ;;
  up)
    echo "[entrypoint] container up — use 'docker exec <nome> entrypoint <comando>'"
    exec tail -f /dev/null
    ;;
  shell|sh|bash)
    exec /bin/sh
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    exec "$cmd" "$@"
    ;;
esac
