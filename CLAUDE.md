# CLAUDE.md — Bonus Ingestion Engine (mini), versão Node

Spec no estilo SDD para o **motor de ingestão de bônus** — o lado que **gera os créditos** que
depois expiram. É a recriação, em escala menor, do fluxo da **integração Vivo / CRMBonus**:
consumir um **arquivo CSV gigante (~5GB)** de clientes aptos, creditar quem tem cadastro e guardar
como **pré-recarga** quem ainda não tem.

Companheiro do `expiration-engine-mini-node`. **Mesmo banco SQLite, mesma tabela
`wallet_transaction`** → os créditos criados aqui são exatamente os que o motor de expiração
processa depois. Demo fim-a-fim: ingere arquivo → carteiras ganham crédito → motor expira.

> Foco da entrevista: provar que sei **processar arquivo enorme sem estourar memória**, em janela
> curta (D-1), com idempotência e reprocesso. O ponto técnico é **streaming + backpressure +
> batching**, não a regra de negócio. Implemente exatamente o que está em §6–§9.

---

## 1. Contexto de negócio (o case Vivo, em 30s)

A Vivo mandava **mensalmente** um arquivo em **gigabytes** com todos os clientes aptos a receber
bônus (quem pagou a conta em dia). Contrato exigia processar em **D-1** — no mesmo dia do envio.
Nem todo cliente Vivo tinha cadastro na CRMBonus, então o motor tratava **dois casos**:

1. **Tem cadastro** → converte o bônus em **crédito** (`RECHARGE`) na carteira + linha no extrato.
2. **Não tem cadastro** → guarda como **pré-recarga** (`PRE_RESERVED`); quando a pessoa se cadastra,
   o crédito cai automaticamente no fluxo de onboarding.

Tudo vira extrato auditável. No original isso rodava em Node/TS orquestrado por Lambda /
Cloud Function, em horários fora de pico.

---

## 2. O problema técnico (o que eles querem saber)

Um CSV de 5GB **não cabe** carregado em memória. A solução é **stream de ponta a ponta**: ler em
pedaços, parsear linha a linha, agrupar em lotes e gravar, deixando o Node aplicar **backpressure**
(se o banco está lento, o leitor desacelera sozinho). Mais: o processo precisa ser **idempotente**
(reprocessar o mesmo arquivo não pode duplicar crédito) e **retomável** (se cair na linha 8 milhões,
recomeça do checkpoint, não do zero).

Essas quatro palavras são a resposta: **streaming, backpressure, batching, idempotência**.

---

## 3. Escopo

### Dentro (MVP)
- Ler CSV gigante via **stream** (nunca `readFileSync`).
- Parse por linha + **validação** de cada registro.
- **Lookup de cadastro** em lote (CPF/telefone → carteira).
- Caso 1 → cria `RECHARGE`. Caso 2 → cria `PRE_RESERVED` (tabela `pre_charge`).
- **Bulk insert** por lote, em uma transação SQL.
- **Idempotência** por chave natural (origin + cycle + cpf).
- **Checkpoint/resume** (retoma do último lote confirmado).
- **Dead-letter**: linhas inválidas vão pra arquivo de rejeição com motivo, sem parar o processo.
- **Métricas**: lidas, creditadas, pré-recarga, rejeitadas, throughput, tempo.
- Gerador de **CSV de volume** para a demo (N linhas configurável).
- Endpoint/CLI de **onboarding** que converte pré-recarga em crédito (fecha o ciclo do caso 2).

### Fora (não fazer agora)
- Kafka, Lambda/Cloud Function reais (só simular o disparo).
- Antifraude, dedupe fuzzy, enriquecimento de dados.
- Multitenância, auth.
- Leitura direta de S3/GCS (mencionar como evolução — ver §13).

---

## 4. Stack e estrutura

Mesma stack do motor de expiração: **Node 20+, TypeScript, better-sqlite3, Fastify, Vitest.**
Parser: `csv-parse` (modo stream). Concorrência: `p-limit` ou semáforo próprio.

```
src/ingestion/
  domain/
    bonusRecord.ts        <- VO da linha (cpf, phone, amountCents, cycle, origin)
    creditPolicy.ts       <- decide: tem carteira -> RECHARGE ; senão -> PRE_RESERVED
    money.ts              <- reaproveitar o do projeto de expiração (centavos)
  ports/
    customerLookup.ts     <- findWalletsByKeys(keys[]) -> Map<key, walletId>
    walletWriter.ts       <- bulkCredit(rows), bulkPreCharge(rows)
    checkpointStore.ts    <- load()/save(batchNo)
    rejectSink.ts         <- write(line, reason)
  usecase/
    ingestBonusFile.ts    <- orquestra o pipeline de streaming
    redeemPreCharge.ts    <- onboarding: PRE_RESERVED -> RECHARGE
  infra/
    csvSource.ts          <- createReadStream + csv-parse (stream)
    sqliteCustomerLookup.ts
    sqliteWalletWriter.ts
    sqliteCheckpoint.ts
    fileRejectSink.ts
    cli.ts                <- `ingest <arquivo>`, `redeem <cpf>`
  index.ts
tools/
  genCsv.ts               <- gera CSV de volume p/ demo
test/
  *.test.ts
```

---

## 5. Modelo de dados

Reusa `wallet_transaction` (do motor de expiração) para os créditos. Adiciona duas tabelas:

`customer` (mock de cadastro, alimenta o lookup):

| coluna     | tipo | nota                          |
|------------|------|-------------------------------|
| cpf        | TEXT | chave de busca (PK ou unique) |
| phone      | TEXT | chave alternativa             |
| wallet_id  | TEXT | carteira do cliente           |

`pre_charge` (caso 2 — crédito pendente de onboarding):

| coluna     | tipo    | nota                                         |
|------------|---------|----------------------------------------------|
| id         | TEXT    | PK                                           |
| cpf        | TEXT    | chave para casar no onboarding               |
| phone      | TEXT    |                                              |
| amount     | INTEGER | centavos                                     |
| cycle      | TEXT    | ex. '2026-06' (mês do arquivo)               |
| origin     | TEXT    | ex. 'vivo'                                    |
| status     | TEXT    | PENDING / REDEEMED                            |
| created_at | TEXT    | ISO                                          |

`ingest_checkpoint` (resume):

| coluna       | tipo | nota                                |
|--------------|------|-------------------------------------|
| file_key     | TEXT | origin+cycle+nome (PK)              |
| last_batch   | INT  | último lote confirmado              |
| updated_at   | TEXT | ISO                                 |

**Idempotência:** índice **unique** em `wallet_transaction(origin, cycle, cpf)` *(adicionar essas
colunas no MVP de ingestão)* e em `pre_charge(origin, cycle, cpf)`. Bulk write usa
`INSERT ... ON CONFLICT DO NOTHING`. Reprocessar o mesmo arquivo não duplica nada.

---

## 6. Formato do CSV

Colunas mínimas (header na 1ª linha):

```
cpf,phone,amount,cycle,origin
12345678901,11999990000,50.00,2026-06,vivo
```

- `amount` em reais no arquivo → converter para **centavos** na borda.
- `cycle` identifica o lote mensal (parte da chave de idempotência).
- Linhas sem cpf **e** sem phone, ou com `amount <= 0`, ou cpf inválido → **rejeitadas** (dead-letter).

---

## 7. Pipeline de ingestão (o coração)

`ingestBonusFile({ filePath, batchSize=1000, lookupConcurrency=8, resume=true })`

Fluxo em stream, com **backpressure** via `stream.pipeline` / async iterator:

1. `createReadStream(filePath)` → `csv-parse({ columns:true })` → itera linha a linha (nunca
   materializa o arquivo inteiro).
2. **Valida** cada linha → `BonusRecord` ou manda pro `rejectSink` com o motivo.
3. **Agrupa** em lotes de `batchSize`. Se `resume`, **pula** os lotes ≤ `checkpoint.last_batch`.
4. Por lote (com concorrência limitada, mas **um lote por vez** para preservar a ordem do
   checkpoint):
   a. `customerLookup.findWalletsByKeys(keys)` — **uma query** `WHERE cpf IN (...)` para o lote
      inteiro (nada de N+1).
   b. **Particiona**: tem carteira → linha de `RECHARGE`; não tem → linha de `pre_charge`.
   c. `walletWriter` grava o lote em **uma transação SQL** (bulk credit + bulk pre-charge),
      com `ON CONFLICT DO NOTHING` (idempotência).
   d. `checkpointStore.save(batchNo)`.
   e. Atualiza métricas e loga a cada N lotes (throughput linhas/s).
5. No fim: relatório `{ read, credited, preCharged, rejected, durationMs, rowsPerSec }`.

Regras-chave:
- **Nada de `Promise.all` sobre o arquivo todo** — isso recria o problema de memória. Backpressure
  é o que segura o ritmo.
- **Falha em um lote** não derruba o processo: loga, conta como falha, segue (ou aborta com base
  num limiar de erros consecutivos, igual ao motor de expiração).
- **PII**: nunca logar cpf/phone em claro — mascarar (`123.***.**8-90`).

---

## 8. Onboarding — fechando o caso 2

`redeemPreCharge(cpf)`:
1. Cria/garante `customer` + `wallet` para o cpf.
2. Busca `pre_charge` com `status=PENDING` desse cpf.
3. Para cada um: cria `RECHARGE` na carteira (mesma chave de idempotência) e marca
   `pre_charge.status=REDEEMED` na mesma transação.

Isso demonstra o fluxo completo do case: quem não tinha cadastro recebe o bônus retroativo ao
se cadastrar.

---

## 9. Boas práticas que o doc precisa exibir (checklist da entrevista)

1. **Streaming, não buffering** — `createReadStream` + parser em stream; memória constante
   independente do tamanho do arquivo.
2. **Backpressure** — `stream.pipeline`/async iterator; o leitor desacelera quando o sink atrasa.
3. **Batching + bulk write** — 1 transação por lote, não 1 por linha (mata o N+1 de I/O).
4. **Lookup em lote** — `IN (...)` por lote, não uma consulta por linha.
5. **Idempotência** — chave natural + `ON CONFLICT DO NOTHING`; reprocesso é seguro.
6. **Checkpoint/resume** — retoma do último lote; essencial em arquivo de horas.
7. **Dead-letter + métricas + PII mascarada** — robustez e observabilidade sem parar o lote bom.

---

## 10. API / CLI

- CLI `ingest <arquivo> [--no-resume]` — roda o pipeline e imprime o relatório.
- CLI `redeem <cpf>` — converte pré-recarga em crédito.
- (Opcional) `POST /ingest` com `{ filePath }` para disparar via HTTP, espelhando o trigger
  Lambda/Cloud Function do original.

---

## 11. Demo de volume

`tools/genCsv.ts --rows 5_000_000 --hit-rate 0.7` gera um CSV grande (configurável), onde 70% dos
cpfs já existem em `customer` (viram crédito) e 30% não (viram pré-recarga). Mostra na entrevista:

- memória estável durante a ingestão (printar `process.memoryUsage().rss` periodicamente);
- throughput em linhas/s e tempo total (argumento do D-1);
- matar o processo no meio e rodar de novo → retoma do checkpoint, sem duplicar.

Para citar 5GB de verdade, gerar ~5M+ linhas chega na ordem de grandeza certa.

---

## 12. Critérios de aceite (testes Vitest)

- Parser/validação: linha boa vira `BonusRecord`; linha ruim vai pro reject com o motivo certo.
- creditPolicy: cpf com carteira → RECHARGE; sem carteira → PRE_RESERVED.
- Lookup em lote: 1 query por lote, mapeia todas as chaves.
- Bulk write idempotente: rodar o mesmo lote 2x não duplica (ON CONFLICT).
- Checkpoint: matar após o lote 3 e retomar começa no lote 4; resultado final idêntico ao run único.
- Onboarding: `redeem` converte todos os PENDING do cpf e marca REDEEMED.
- Memória: teste de ingestão de arquivo grande mantém rss sob um teto (smoke test).
- Fim-a-fim: ingerir → rodar motor de expiração → créditos vencidos viram EXPIRED.

---

## 13. Evoluções (mencionar, não implementar)

- Ler direto de **S3/GCS** por stream (sem baixar o arquivo); suportar **gzip** no pipe.
- **Particionar** o arquivo e processar partições em paralelo (vários workers/Lambdas).
- Mover o write para **Kafka** (produz eventos de crédito; consumidores aplicam) — desacopla
  ingestão de escrita.
- **V2 em Go**: o pipeline vira `bufio.Scanner`/`encoding/csv` + goroutines + channels com buffer
  para backpressure — mesmo desenho, throughput maior. Mesma narrativa do motor de expiração.

---

## 14. Para o agente — ordem de execução sugerida

1. Schema novo (`customer`, `pre_charge`, `ingest_checkpoint`) + colunas de idempotência.
2. `bonusRecord` (validação) + `creditPolicy` + testes.
3. `csvSource` (stream + csv-parse) + teste com arquivo pequeno.
4. `customerLookup` em lote + `walletWriter` bulk idempotente + testes.
5. `checkpointStore` + `rejectSink` + testes.
6. `ingestBonusFile` (pipeline completo) + teste de resume e idempotência.
7. `redeemPreCharge` + teste.
8. `tools/genCsv` + medir memória/throughput num arquivo grande.
9. CLI/HTTP.

Testar cada bloco antes de seguir. Não materializar o arquivo em memória em nenhum ponto.
