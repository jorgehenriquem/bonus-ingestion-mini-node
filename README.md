# Bonus Ingestion Engine — mini (Node/TypeScript)

Motor de ingestão de bônus em escala reduzida, criando o fluxo de integração: consumir um CSV gigante de clientes aptos, creditar quem tem cadastro e guardar como pré-recarga quem ainda não tem.

Companheiro do [`expiration-engine-mini-node`](https://github.com/jorgehenriquem/expiration-engine-mini-node). Mesmo banco SQLite, mesma tabela `wallet_transaction` — os créditos criados aqui são exatamente os que o motor de expiração processa depois.

---

## O problema técnico

Um CSV de 5 GB **não cabe em memória**. A solução é stream de ponta a ponta: ler em pedaços, parsear linha a linha, agrupar em lotes e gravar, deixando o Node aplicar **backpressure** naturalmente. Além disso, o processo precisa ser **idempotente** (reprocessar o mesmo arquivo não duplica crédito) e **retomável** (se cair na linha 8 milhões, recomeça do checkpoint, não do zero).

Quatro palavras resumem a solução: **streaming · backpressure · batching · idempotência**.

---

## Instalação

**Requisito:** Node 20+. Nada mais — sem Docker, sem Postgres.

```bash
git clone https://github.com/jorgehenriquem/bonus-ingestion-mini-node
cd bonus-ingestion-mini-node
npm install
```

O banco SQLite é criado automaticamente em `data/ingestion.db` na primeira execução.

---

## Uso

### 1. Gerar CSV de volume

```bash
npx tsx tools/genCsv.ts --rows 1000000 --hit-rate 0.7 --output data/sample.csv
```

| Flag | Default | Descrição |
|------|---------|-----------|
| `--rows N` | 100 000 | Número de linhas a gerar |
| `--hit-rate R` | 0.7 | Fração de CPFs que já têm carteira (viram RECHARGE) |
| `--output PATH` | data/sample.csv | Caminho do arquivo gerado |
| `--seed-customers` | true | Insere os clientes "hit" no banco antes de gerar |

### 2. Ingerir o arquivo

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
| `--expired-rate R` | 0 | Fração de RECHARGEs criados já vencidos (útil para testar o motor de expiração) |

Todo RECHARGE nasce com `expires_in = now + 180 dias`. Com `--expired-rate`, essa fração recebe `expires_in = now - 200 dias` (já expirado para o motor de expiração atuar).

Saída ao final:

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

### 3. Onboarding — registrar cliente e converter pré-recarga

```bash
# Registra o cliente e converte automaticamente as pré-recargas pendentes
npx tsx src/ingestion/infra/cli.ts register <cpf>
npx tsx src/ingestion/infra/cli.ts register <cpf> --phone 11999990000 --wallet-id wallet-xyz

# Ou só converter (se o customer já existe)
npx tsx src/ingestion/infra/cli.ts redeem <cpf>
```

O `register` cria o `customer` no banco e em seguida converte todos os `pre_charge PENDING` daquele CPF em `RECHARGE` com `expires_in = now + 180 dias` — tudo em uma única transação.

### 4. Testes

```bash
npm test
```

---

## Demo de entrevista

```bash
# Gera 1 M de linhas
npx tsx tools/genCsv.ts --rows 1000000

# Ingere — observe memória estável (~80-100 MB)
npx tsx src/ingestion/infra/cli.ts ingest data/sample.csv

# Mata o processo no meio, roda de novo → retoma do checkpoint (credited=0 no segundo run)
npx tsx src/ingestion/infra/cli.ts ingest data/sample.csv

# Onboarding: cliente sem cadastro se registra e recebe o bônus retroativo
npx tsx src/ingestion/infra/cli.ts register 00000035000
```

Para resetar o banco: `del data\ingestion.db` (Windows) ou `rm data/ingestion.db` (Unix).

---

## Arquitetura

```
src/ingestion/
  domain/
    bonusRecord.ts      VO da linha CSV + validação + maskCpf
    creditPolicy.ts     decide: tem carteira → RECHARGE ; senão → PRE_RESERVED
  ports/
    customerLookup.ts   interface: findWalletsByKeys(keys[])
    walletWriter.ts     interface: bulkCredit / bulkPreCharge
    checkpointStore.ts  interface: load / save
    rejectSink.ts       interface: write / close
  usecase/
    ingestBonusFile.ts  orquestra o pipeline de streaming
    redeemPreCharge.ts  onboarding: PRE_RESERVED → RECHARGE
  infra/
    db.ts               conexão SQLite + migrations
    csvSource.ts        createReadStream + csv-parse (async generator)
    sqliteCustomerLookup.ts
    sqliteWalletWriter.ts
    sqliteCheckpoint.ts
    fileRejectSink.ts   JSONL com CPF mascarado
    cli.ts              CLI: ingest / register / redeem
tools/
  genCsv.ts             gerador de CSV de volume
test/
  *.test.ts             43 testes (Vitest)
```

### Decisões técnicas

| Decisão | Motivo |
|---------|--------|
| `createReadStream` + `csv-parse` em modo stream | Memória constante independente do tamanho do arquivo |
| `for await` sobre o parser | Backpressure nativo — o leitor desacelera quando o banco atrasa |
| Bulk `INSERT OR IGNORE` por lote | 1 transação por lote, não 1 por linha; elimina N+1 de I/O |
| `IN (...)` por lote no lookup | 1 query por lote para resolver todas as carteiras |
| PK determinística `origin:cycle:cpf` | Idempotência limpa — reprocessar não duplica mesmo sem checkpoint |
| Checkpoint salvo **na mesma transação** do bulk write | Elimina a janela de crash entre write e save do checkpoint |
| Aborta após 3 erros consecutivos | Lotes bons anteriores preservados; falha isolada não derruba tudo |
| `expires_in` obrigatório, padrão now + 180 dias | Todo crédito nasce com vencimento definido para o motor de expiração |
| `--expired-rate` cria créditos com `expires_in` no passado | Gera terreno para o motor de expiração sem precisar esperar 180 dias |

### Schema SQLite

```sql
wallet_transaction  -- créditos (RECHARGE); UNIQUE(origin, cycle, cpf)
customer            -- mock de cadastro: cpf → wallet_id
pre_charge          -- pré-recargas pendentes; UNIQUE(origin, cycle, cpf)
ingest_checkpoint   -- file_key → last_batch (resume)
```

---

## Formato do CSV

```
cpf,phone,amount,cycle,origin
12345678901,11999990000,50.00,2026-06,vivo
```

Linhas rejeitadas (CPF inválido, amount ≤ 0, cycle/origin ausente) vão para `<arquivo>.rejected.jsonl` com o motivo e o CPF mascarado, sem parar o processamento.

---

## Evoluções possíveis

- Ler direto de **S3/GCS** via stream (sem baixar o arquivo); suporte a **gzip** no pipe.
- **Particionar** o arquivo e processar partições em paralelo (múltiplos workers/Lambdas).
- Mover o write para **Kafka** — desacopla ingestão de escrita.
- **V2 em Go**: `bufio.Scanner` + goroutines + channels com buffer — mesmo desenho, throughput maior.
