# Bonus Ingestion Engine (Node/TypeScript)

Motor de ingestão de bônus: consome um CSV grande de clientes aptos, credita quem tem cadastro e
guarda como pré-recarga quem ainda não tem. Quando a pessoa se cadastra, o valor guardado vira
crédito automaticamente.

Acompanha um **servidor MCP**, que permite operar o motor por linguagem natural a partir de um
cliente compatível.

---

## O problema técnico

Um CSV de 5 GB **não cabe em memória**. A solução é stream de ponta a ponta: ler em pedaços,
parsear linha a linha, agrupar em lotes e gravar, deixando o Node aplicar **backpressure**
naturalmente. Além disso, o processo precisa ser **idempotente** (reprocessar o mesmo arquivo não
duplica crédito) e **retomável** (se cair na linha 8 milhões, recomeça do checkpoint, não do zero).

Quatro palavras resumem a solução: **streaming · backpressure · batching · idempotência**.

---

## Como rodar

### Com Docker (recomendado)

Não exige Node nem toolchain de compilação na máquina.

```bash
docker build -t bonus-ingestion .
```

O container usa um **volume nomeado** (`bonus-data`) para o banco e os CSVs — não um bind mount do
host. Isso mantém o SQLite num filesystem Linux nativo, onde o travamento de arquivo que o WAL
depende se comporta corretamente.

```bash
# Gera o CSV de volume
docker run --rm -v bonus-data:/app/data bonus-ingestion gencsv --rows 200000 --hit-rate 0.7

# Ingere com teto rígido de memória
docker run --rm -v bonus-data:/app/data --memory=256m --cpus=1 \
  bonus-ingestion ingest data/sample.csv

# Onboarding
docker run --rm -v bonus-data:/app/data bonus-ingestion register 00000199999

# Suíte de testes dentro do container
docker run --rm bonus-ingestion test

# Sem argumento: lista os comandos disponíveis
docker run --rm bonus-ingestion
```

Container residente, para usar com `docker exec`:

```bash
docker compose up -d
docker exec bonus-ingestion entrypoint ingest data/sample.csv
docker exec -it bonus-ingestion entrypoint shell
```

Para zerar os dados: `docker volume rm bonus-data`.

### Direto com Node

**Requisito:** Node 20+.

```bash
npm ci
```

O banco SQLite é criado automaticamente em `data/ingestion.db` na primeira execução.

---

## Uso pela CLI

### Gerar CSV de volume

```bash
npx tsx tools/genCsv.ts --rows 1000000 --hit-rate 0.7 --output data/sample.csv
```

| Flag | Default | Descrição |
|------|---------|-----------|
| `--rows N` | 100 000 | Número de linhas a gerar |
| `--hit-rate R` | 0.7 | Fração de CPFs que já têm carteira (viram RECHARGE) |
| `--output PATH` | data/sample.csv | Caminho do arquivo gerado |
| `--seed-customers` | true | Insere os clientes "hit" no banco antes de gerar |

O gerador **apaga** `customer` e `pre_charge` antes de popular.

### Ingerir o arquivo

```bash
npx tsx src/ingestion/infra/cli.ts ingest data/sample.csv
npx tsx src/ingestion/infra/cli.ts ingest data/sample.csv --no-resume
npx tsx src/ingestion/infra/cli.ts ingest data/sample.csv --batch-size 1000
npx tsx src/ingestion/infra/cli.ts ingest data/sample.csv --expired-rate 0.3
```

| Flag | Default | Descrição |
|------|---------|-----------|
| `--no-resume` | — | Ignora checkpoint e processa do zero |
| `--batch-size N` | 500 | Linhas por lote |
| `--expired-rate R` | 0 | Fração de RECHARGEs criados já vencidos |

Todo RECHARGE nasce com `expires_in = now + 180 dias` (configurável por `BONUS_EXPIRY_DAYS`). Com
`--expired-rate`, a fração indicada nasce com `expires_in` no passado — útil para exercitar
consumidores que reagem a crédito vencido sem esperar meio ano.

```
[ingest] RELATÓRIO FINAL:
  Lidas:          100.000
  Creditadas:      70.000
  └ já vencidas:  21.000
  Pré-recarga:     30.000
  Rejeitadas:           0
  Duração:           8.4s
  Throughput:   118.000 r/s
```

### Onboarding

```bash
# Registra o cliente e converte automaticamente as pré-recargas pendentes
npx tsx src/ingestion/infra/cli.ts register <cpf>
npx tsx src/ingestion/infra/cli.ts register <cpf> --phone 11999990000 --wallet-id wallet-xyz

# Ou só converter (se o customer já existe)
npx tsx src/ingestion/infra/cli.ts redeem <cpf>
```

O `register` cria o `customer` e converte todos os `pre_charge PENDING` daquele CPF em `RECHARGE`,
numa única transação. Sem `--wallet-id`, a carteira é derivada por hash do CPF — determinística, e
sem carregar o documento dentro do identificador.

---

## Servidor MCP

O motor também se expõe por [MCP](https://modelcontextprotocol.io), o que permite operá-lo
conversando com um assistente compatível em vez de montar comandos na mão:

> *"Gera um CSV de 200 mil linhas com 70% de hit e ingere."*
> *"Como está a ingestão?"*
> *"Quantas pré-recargas pendentes existem no ciclo 2026-06?"*

O servidor é um **adaptador de entrada**, irmão da CLI: as tools chamam os mesmos use cases, sem
duplicar regra de negócio.

### Subir

```bash
docker run -i --rm -v bonus-data:/app/data bonus-ingestion:latest mcp
```

Ou, fora do container:

```bash
npm run mcp
```

### Conectar num cliente MCP

```json
{
  "mcpServers": {
    "bonus-ingestion": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "bonus-data:/app/data",
        "bonus-ingestion:latest",
        "mcp"
      ]
    }
  }
}
```

O `-i` é obrigatório: sem stdin aberto não existe canal JSON-RPC. O `-v` preserva o banco entre
sessões.

Para inspecionar as tools sem um cliente:

```bash
npx @modelcontextprotocol/inspector docker run -i --rm -v bonus-data:/app/data bonus-ingestion:latest mcp
```

### Tools

| Tool | O que faz |
|------|-----------|
| `get_data_root` | Lista a raiz permitida e os arquivos nela |
| `generate_sample_csv` | Gera CSV de volume (destrutivo: limpa `customer` e `pre_charge`) |
| `start_ingestion` | Dispara a ingestão em background, devolve `jobId` |
| `get_ingestion_status` | Snapshot do job, ou lista os recentes |
| `cancel_ingestion` | Corta entre lotes; o checkpoint permite retomar |
| `get_wallet_summary` | Totais de crédito e pré-recarga, filtráveis por `cycle`/`origin` |
| `lookup_customer` | Consulta cadastro por CPF ou telefone |
| `register_customer` | Cadastra e converte pré-recargas pendentes |
| `list_rejected_rows` | Agrupa os motivos de rejeição do dead-letter |

### Decisões do servidor

| Decisão | Motivo |
|---------|--------|
| Ingestão em processo filho | `better-sqlite3` é síncrono; rodar inline deixaria o servidor sem responder durante todo o processamento |
| `start_ingestion` devolve `jobId`, não o relatório | Chamada de tool tem timeout de cliente; arquivo grande leva minutos |
| Allowlist de caminho (`INGEST_ROOT`) | Quem escolhe os argumentos é o modelo; `filePath` livre seria leitura arbitrária do disco |
| CPF mascarado em toda saída | A resposta da tool vai para o contexto do modelo e para o histórico da conversa |
| Todo log em `stderr` | Em stdio o stdout é o canal JSON-RPC; um `console.log` corrompe a sessão |
| Nove tools, não trinta | Descrição de tool ocupa contexto em toda requisição e degrada a seleção |

### Limites conhecidos

- O histórico de jobs vive na memória do processo. Com `--rm`, cada sessão é um container novo:
  um job iniciado antes não aparece depois, e encerrar a sessão interrompe a ingestão em andamento.
  Os lotes confirmados ficam salvos — reingerir retoma do checkpoint.
- Apenas tools; `resources` e `prompts` do protocolo não são implementados.
- Acompanhamento por consulta, sem `notifications/progress`.

---

## Roteiro de demonstração

```bash
docker build -t bonus-ingestion .

# 1M de linhas, 70% com cadastro
docker run --rm -v bonus-data:/app/data bonus-ingestion gencsv --rows 1000000

# Ingere sob teto rígido de 256 MB
docker run --rm -v bonus-data:/app/data --memory=256m --cpus=1 \
  bonus-ingestion ingest data/sample.csv

# Roda de novo → retoma do checkpoint, Creditadas: 0
docker run --rm -v bonus-data:/app/data bonus-ingestion ingest data/sample.csv

# Cliente sem cadastro se registra e recebe o bônus retroativo
docker run --rm -v bonus-data:/app/data bonus-ingestion register 00000999999
```

O `--memory=256m` é o ponto central: o teto é imposto pelo kernel, então um pipeline que carregasse
o arquivo em memória levaria OOM kill. Atravessar um arquivo de gigabytes dentro de 256 MB é a
evidência de que o consumo não acompanha o tamanho da entrada.

```
[ingest] RELATÓRIO FINAL:
  Lidas:          200.000
  Creditadas:     140.000
  Pré-recarga:     60.000
  Rejeitadas:           0
  Duração:            3.8s
  Throughput:    53.173 r/s
```

---

## Arquitetura

```
src/
  ingestion/
    domain/
      bonusRecord.ts      VO da linha CSV + validação + maskCpf
      creditPolicy.ts     decide: tem carteira → RECHARGE ; senão → PRE_RESERVED
      expiry.ts           prazo de validade do crédito (env-configurável)
    ports/
      customerLookup.ts   interface: findWalletsByKeys(keys[])
      walletWriter.ts     interface: bulkCredit / bulkPreCharge
      checkpointStore.ts  interface: load / save
      rejectSink.ts       interface: write / close
    usecase/
      ingestBonusFile.ts  pipeline de streaming
      redeemPreCharge.ts  PRE_RESERVED → RECHARGE
      registerCustomer.ts cadastro + conversão das pendências
    infra/
      db.ts               conexão SQLite + migrations
      csvSource.ts        createReadStream + csv-parse (async generator)
      logger.ts           saída em stderr
      sqliteCustomerLookup.ts
      sqliteWalletWriter.ts
      sqliteCheckpoint.ts
      fileRejectSink.ts   JSONL com CPF mascarado
      cli.ts              CLI: ingest / register / redeem
  mcp/
    server.ts             servidor stdio
    config.ts             configuração por env
    safety.ts             allowlist de caminho, tetos de listagem
    jobs.ts               registro de jobs de ingestão
    ingestionChild.ts     processo filho que executa o pipeline
    tools/                as nove tools
tools/
  genCsv.ts               gerador de CSV de volume
test/
  *.test.ts               65 testes (Vitest)
```

Os adaptadores de entrada — `cli.ts` e `mcp/server.ts` — são irmãos sobre `usecase/`. Nenhum passa
pelo outro.

### Decisões técnicas

| Decisão | Motivo |
|---------|--------|
| `createReadStream` + `csv-parse` em modo stream | Memória constante independente do tamanho do arquivo |
| `for await` sobre o parser | Backpressure nativo — o leitor desacelera quando o banco atrasa |
| Bulk `INSERT OR IGNORE` por lote | 1 transação por lote, não 1 por linha; elimina N+1 de I/O |
| `IN (...)` por lote no lookup | 1 query por lote para resolver todas as carteiras |
| PK determinística `origin:cycle:cpf` | Idempotência limpa — reprocessar não duplica mesmo sem checkpoint |
| Checkpoint salvo **na mesma transação** do bulk write | Elimina a janela de crash entre write e save |
| Aborta após 3 erros consecutivos | Lotes bons anteriores preservados; falha isolada não derruba tudo |
| `wallet_id` derivado por hash | Identificador não carrega o CPF; determinístico para reregistro |
| Cancelamento cooperativo entre lotes | Só corta em ponto já confirmado pelo checkpoint |

### Decisões do Dockerfile

| Decisão | Motivo |
|---------|--------|
| `node:24-bookworm-slim`, não Alpine | A musl libc do Alpine força recompilar o `better-sqlite3` em vez de usar o prebuilt |
| Multi-stage | `python3`/`make`/`g++` são necessários no `npm ci` e lixo no runtime |
| `NODE_ENV` não é `production` no estágio de deps | `tsx` é devDependency e é o runtime do projeto (os imports usam extensão `.ts`) |
| Entrypoint com subcomandos | `docker run ... ingest` em vez de repetir o caminho do arquivo TS |
| `node_modules/.bin/tsx` em vez de `npx` | Sem overhead de resolução e sem `npm notice` sujando o stdout |
| `package-lock.json` versionado | `npm ci` — build reproduzível — não funciona sem o lockfile no repositório |

### Schema SQLite

```sql
wallet_transaction  -- créditos (RECHARGE); índice único parcial (origin, cycle, cpf) WHERE type='RECHARGE'
customer            -- cadastro: cpf → wallet_id
pre_charge          -- pré-recargas pendentes; UNIQUE(origin, cycle, cpf)
ingest_checkpoint   -- file_key → last_batch (resume)
```

---

## Formato do CSV

```
cpf,phone,amount,cycle,origin
12345678901,11999990000,50.00,2026-06,vivo
```

Linhas rejeitadas (CPF inválido, amount ≤ 0, cycle/origin ausente) vão para
`<arquivo>.rejected.jsonl` com o motivo e o CPF mascarado, sem parar o processamento.

---

## Configuração

Referência completa em [`.env.example`](.env.example). Não há carregamento automático de `.env` —
as variáveis vêm do ambiente, o que funciona com `docker run --env-file .env`.

| Variável | Default | Efeito |
|----------|---------|--------|
| `DB_PATH` | `data/ingestion.db` | Caminho do SQLite |
| `DB_BUSY_TIMEOUT_MS` | `5000` | Espera por lock antes de falhar |
| `BONUS_EXPIRY_DAYS` | `180` | Validade do crédito |
| `INGEST_ROOT` | `data` | Raiz permitida para o servidor MCP |
| `INGEST_BATCH_SIZE` | `500` | Linhas por lote |
| `MCP_LIST_LIMIT` | `100` | Teto de itens por listagem |
| `MCP_MAX_CONCURRENT_INGESTIONS` | `1` | Ingestões simultâneas |

---

## Testes

```bash
npm test                              # local
docker run --rm bonus-ingestion test  # no container
```

65 testes cobrindo parsing e validação, política de crédito, lookup em lote, escrita idempotente,
checkpoint e resume, onboarding, e o servidor MCP pelo protocolo real (cliente e servidor ligados
por transporte em memória).

---

## Evoluções possíveis

- Ler direto de **S3/GCS** via stream (sem baixar o arquivo); suporte a **gzip** no pipe.
- **Particionar** o arquivo e processar partições em paralelo.
- Mover o write para **Kafka** — desacopla ingestão de escrita.
- **Transporte HTTP** no servidor MCP, com persistência de jobs e autenticação.
- **V2 em Go**: `bufio.Scanner` + goroutines + channels com buffer — mesmo desenho, throughput maior.
