# Clipes incrementais por faixa (piso diário) — plano

> **Status:** plano de desenho. Nada implementado. Este documento é a
> proposta fechada com o usuário (modelo, base de kills e definição de
> "partida grande") e o roteiro de implementação.
>
> Regra que ele complementa: o segundo fator de busca (rank HLTV) já está
> em produção — ver `src/monitor/teamRanking.ts` e a seção "Second search
> factor" do `README.md`.

---

## 1. O problema

Hoje o bot não tem **controle de quantidade**: ele controla só o **tamanho
mínimo** do clipe (`MIN_KILLS` / `MIN_KILLS_NO_STARS` / `RANK_MIN_KILLS`).
Uma partida 2★ pode render 4k, 5k, 5k, 4k… e todas viram clipe. O dedup
(`hasAce` = canal + partida + mapa + round + jogador) impede repetir o
**mesmo round**, não o mesmo **nível de clipe**.

O pedido do usuário:

- depois de um clipe 3k de partida 0★, **não** repetir 3k de 0★; o próximo
  aceitável é 4k de 0★ ou 3k de 1★;
- depois de 4k de 1★, só 5k de 1★ ou 4k de 2★ — e assim por diante;
- **exceção:** em final / partida muito grande, pode render vários clipes
  do mesmo nível (ex.: três 4k de uma 2★).

Ou seja: o que falta não é um limiar maior, é um **critério incremental**
que suba sozinho conforme o dia já rendeu, sem estrangular a final.

---

## 2. Decisão fechada

| Item | Decisão |
|---|---|
| Modelo | **Piso diário por score** (escolhido pelo usuário) |
| Score | `kills + estrelas` |
| Base de kills | **Equilibrado**: 2★+ rende 4k; 0★/1★ (rank/watchlist) também 4k; sem 3k |
| Partida grande | **final/playoff + evento top-tier + watchlist** → ignora o piso, base 4k, até 3 clipes |
| Persistência | derivada do banco (`clips` + `ace_events`), **sem estado em memória** |
| Escopo | **por canal** (`channel_id`) e **por dia** (dia do Pacífico, o mesmo da cota) |
| Código | **nenhuma alteração nesta etapa** — só este plano |

---

## 3. O modelo

### 3.1 Score do clipe

```
score = kills + estrelas
```

| Score | Exemplos |
|---|---|
| 3 | 3k / 0★ |
| 4 | 4k / 0★ · 3k / 1★ |
| 5 | 5k / 0★ · 4k / 1★ |
| 6 | 5k / 1★ · **4k / 2★** |
| 7 | 5k / 2★ · 4k / 3★ |
| 8 | 5k / 3★ · 4k / 4★ |
| 9 | 5k / 4★ · 4k / 5★ |
| 10 | 5k / 5★ |

É exatamente a moeda da cadeia que o usuário descreveu: cada degrau é
`kills + 1` **ou** `estrelas + 1`.

### 3.2 Piso do dia

```
floor = 0 clipes hoje ? BASE
                       : min(CEILING, melhorScoreHoje + 1)
```

- `melhorScoreHoje` = maior `kills + estrelas` entre os clipes **gerados**
  hoje no canal.
- `BASE` = piso antes do primeiro clipe do dia (default **5**).
- `CEILING` = onde o piso satura (default **8**).

Equivalente à formulação "base + clipes publicados" escolhida pelo usuário:
quando os clipes caem exatamente no piso, `BASE + n` e `melhor + 1` dão o
mesmo número. A forma `melhor + 1` é preferida porque também cobre o caso
em que um clipe **passa acima** do piso (um 5k num dia em que o piso era
4) — sem ela, o dia seguinte àquele 5k aceitaria outro 4k.

**Saturação:** no teto, `floor` para de subir e clipes **do mesmo nível
mais alto** voltam a passar. É intencional: o topo da escada é limitado
pelo teto diário, não pela escada (senão o segundo 5k/3★ de uma partida
diferente seria bloqueado por já existir um).

### 3.3 Limiar efetivo (a conta que entra no tracker)

```
killsNecessárias = max(base(stars, rank, watchlist), floor - stars)
```

- `base(...)` é o que já existe hoje: `minKillsForStars` → `applyRankThreshold`.
- O piso **só sobe o sarrafo**; nunca faz uma partida entrar e nunca
  reduz o limiar base.
- Se `floor - stars > 5` → `Infinity` (bloqueio explícito), o mesmo
  sentinela que o adversário da watchlist já usa em `requiredKills`.
- A ordem importa: **base → rank → piso**. O rank pode baixar 5k para 4k;
  o piso pode subir de volta para 5k se o dia já está cheio. Isso é
  desejado (o rank é fator de **busca**; o piso é fator de **quantidade**).

### 3.4 Partida grande

`isBigMatch` (função pura) = **qualquer** dos critérios:

| Critério | Como reconhecer |
|---|---|
| Fase eliminatória | `stage` do card contém `final`, `semi`, `quarter`, `playoff`, `bracket` |
| Watchlist | `watchlisted === true` (time da lista na partida) |
| Evento top-tier | `TOP_TIER_EVENTS` (extraído para função própria) **e** `stars >= CLIP_BIG_TOPTIER_MIN_STARS` (default 3) |

Efeito dentro de uma partida que **já entrou** pelo filtro normal:

- **ignora o piso** (pode repetir o mesmo nível);
- base própria `CLIP_BIG_MIN_KILLS` (default 4);
- teto próprio por partida `CLIP_MAX_BIG_PER_MATCH` (default 3);
- **conta** para o piso e para o teto diário (não vira flood).

"Grande" **não** faz a partida entrar: `MIN_STARS`/rank/watchlist continuam
decidindo a entrada. Uma final de evento 2★ entra normalmente; uma 0★ sem
rank continua fora.

### 3.5 Tetos

| Teto | Default | Onde é checado |
|---|---|---|
| `CLIP_MAX_PER_MATCH` (normal) | 2 | `handleAce`, antes de OCR/corte |
| `CLIP_MAX_BIG_PER_MATCH` (grande) | 3 | idem |
| `CLIP_MAX_PER_DAY` | 6 | idem |

`CLIP_MAX_PER_DAY = 6` **não é arbitrário**: cada `videos.insert` custa
1600 units e o teto padrão do YouTube é 10000/dia. 6 × 1600 = 9600. Quem
subir `YT_QUOTA_UNITS_PER_DAY` pode subir este teto na mesma proporção.

---

## 4. Simulação — configuração Equilibrado real

Premissas: `MIN_STARS=2`, `MIN_KILLS=4`, `RANK_MIN_KILLS=4`, `BASE=5`,
`CEILING=8`, tetos 2/3/6.

| # | Partida | Round | score | piso antes | Resultado |
|---|---|---|---|---|---|
| 1 | 2★ normal | 4k | 6 | 5 | ✅ → piso 7 |
| 2 | 2★ normal | 4k | 6 | 7 | ❌ (precisa 5k/2★ = 7) |
| 3 | 2★ normal | 5k | 7 | 7 | ✅ → piso 8 |
| 4 | 2★ normal | 5k | 7 | 8 | ❌ |
| 5 | 3★ normal | 4k | 7 | 8 | ❌ |
| 6 | 3★ normal | 5k | 8 | 8 | ✅ → piso 9 → satura em 8 |
| 7 | 2★ normal | 5k | 7 | 8 | ❌ |
| 8 | **final 2★** | 4k ×3 | 6 | 8 | ✅✅✅ (ignora o piso; teto 3) |
| 9 | teto diário | — | — | — | para (6 clipes) |

Leitura: **3 clipes "normais" + até 3 de uma partida grande**. Em dia fraco
o piso fica em 5–6 e um 4k/2★ sozinho já entra; em dia cheio a escada
fecha sozinha.

**Sua cadeia original (0★/3k)** acontece literalmente só no preset
**Volume** (`MIN_KILLS=3`, `RANK_MIN_KILLS=3`) com `BASE=3`, `CEILING=7`:
3k/0★ (3) → 4k/0★ ou 3k/1★ (4) → 5k/0★ ou 4k/1★ (5) → …

> **Por que `BASE=5` e não 3:** com `MIN_STARS=2`, o clipe mais barato que
> existe é 4k/2★ = **6**. Um `BASE=3`/`CEILING=7` faria o **primeiro**
> clipe do dia jogar o piso para 7 e quase encerrar o dia. O piso precisa
> ser calibrado à faixa de estrelas que você realmente aceita.

---

## 5. `MIN_STARS` / `MIN_KILLS` / `RANK_*` ficam obsoletos?

**Não.** O piso não substitui nenhuma chave — ele separa duas decisões que
hoje estão misturadas:

> `MIN_KILLS` responde "**o que é** um clipe" (qualidade).
> O piso responde "**quantos** o dia aceita" (quantidade).

| Chave | Papel hoje | Com o piso | Muda? |
|---|---|---|---|
| `MIN_STARS` / `TOP_TIER_ONLY` | decide se a partida entra | idem — o piso **nunca** faz entrar | não |
| `MIN_KILLS` / `MIN_KILLS_NO_STARS` | limiar base por estrela | continua sendo o **piso absoluto** da conta (`max(base, piso − stars)`) | valor sim (2★ 5k → 4k), papel não |
| `RANK_*` | segundo fator: 0★/1★ entra com 4k | idem; o piso pode subir por cima | não |
| Watchlist | override explícito por time/jogador | idem (ver decisão aberta 12.2) | não |
| `MAX_RECORDINGS` | quantas partidas gravar ao mesmo tempo | idem | não |
| `SHORTS_*` | derivados do clipe publicado | idem | não |

O que muda de verdade:

1. **`MIN_KILLS` deixa de ser o controle de volume.** Sozinho, baixar para
   4k em 2★ aumentaria muito o número de clipes. O piso é o que torna o
   preset Equilibrado seguro — os dois andam juntos.
2. **`MIN_KILLS_NO_STARS` fica quase morto.** Com
   `RANK_STARS_MODE=below-general`, 0★ só entra por rank, e o rank já
   impõe 4k. Ele continua existindo para watchlist/legado; é candidato a
   depreciação futura, não a remoção agora.
3. **`MIN_KILLS` passa a ter um valor por faixa que reflete a escada**, não
   um degrau único. Na prática, o preset Equilibrado é uma mudança de
   **configuração** (`MIN_KILLS=4`), não de arquitetura.

Efeito prático com o `.env` atual (`MIN_STARS=2`, `below-general`):

| Partida | Hoje | Com Equilibrado | Observação |
|---|---|---|---|
| 2★ rankeada | 5k | **4k** | única mudança real de volume |
| 2★ sem rank | 5k | **4k** | idem |
| 0★/1★ rankeada | 4k | 4k | igual |
| 3★+ | 5k | 5k | igual |
| 0★ sem rank | não entra | não entra | igual |

---

## 6. Onde o estado vive

**Nada de tabela nova, nada de estado em memória.** O piso é derivado:

```sql
SELECT COUNT(*)                          AS clipesHoje,
       MAX(c.kills + c.stars)            AS melhorScore
FROM clips c
JOIN ace_events a ON a.id = c.ace_id
WHERE c.channel_id = ?
  AND c.is_shorts = 0
  AND c.created_at >= :inicioDoDia
```

- `is_shorts = 0` é obrigatório: o Short do mesmo clipe é outra linha em
  `clips` (`is_shorts = 1`) e contaria duas vezes.
- `channel_id` já existe em `clips` — BR e EN contam separado, de graça.
- Dia = `startOfDaySql(new Date(), cfg.YT_QUOTA_TIMEZONE)`
  (`src/timeZone.ts`), o **mesmo** dia da cota. Um "dia" só no sistema.
- Clipes por partida:
  ```sql
  SELECT COUNT(*) FROM clips c JOIN ace_events a ON a.id = c.ace_id
  WHERE a.channel_id = ? AND a.match_id = ? AND c.is_shorts = 0
  ```
  (por partida inteira, não por dia — partida não deve atravessar o piso
  de um dia para o outro).

### 6.1 Colunas novas em `clips`

Entram em `CLIP_COLUMNS` (`src/db.ts`), que já faz `ALTER TABLE` idempotente
por `PRAGMA table_info`:

| Coluna | Tipo | Por quê |
|---|---|---|
| `kills` | INTEGER | score e diagnóstico |
| `stars` | INTEGER | score (0 = desconhecido) |
| `is_big` | INTEGER NOT NULL DEFAULT 0 | auditoria da exceção |
| `floor_before` | INTEGER | diagnóstico: piso no momento do corte |
| `min_kills` | INTEGER | limiar efetivo aplicado (base + rank + piso) |

Nenhuma coluna é `NOT NULL` sem default: o banco em produção tem clipes
antigos. Migração = `ALTER TABLE` no boot, sem rebuild, sem backup
obrigatório (não é destrutiva).

### 6.2 Clipes antigos / recém-implantados

`kills`/`stars` nulos não entram no `MAX`, mas entram no `COUNT`. Por isso a
fórmula mantém o termo de contagem:

```
floor = min(CEILING, max(BASE + clipesHoje, melhorScoreHoje + 1))
```

Com `melhorScoreHoje = COALESCE(MAX(...), BASE - 1)`. No dia da virada,
clipes antigos só empurram o piso por contagem (conservador). Backfill
opcional de `kills` a partir de `stats.killCount` do sidecar
(`scripts/backfill-clip-ladder.ts --apply`, mesmo padrão do
`enrich-clip.ts`); `stars` não tem fonte retroativa — fica NULL e o dia
seguinte já nasce certo.

### 6.3 Falha e corrida

- **Leitura do banco falhou** → piso = `BASE` e log `warn` (fail-open). O
  piso é controle de quantidade; bloquear clipe por hiccup de SQLite é
  pior que gerar um clipe a mais.
- **Corrida** entre dois trackers (2–4 recorders simultâneos): os dois leem
  o mesmo piso e podem passar. Resíduo aceito e limitado pelo teto diário;
  o teto é reconferido dentro de `handleAce` antes do corte.

---

## 7. Onde entra no código

### 7.1 Camada 1 — detecção (`minKillsFor`, `src/main.ts`)

`minKillsFor(player, team)` já é o ponto único de decisão por round
(chamado pelo `trackEvent` a cada round). Ele passa a:

1. resolver a base atual (watchlist → estrelas → rank) — **sem mudança**;
2. se `CLIP_FLOOR_ENABLED` e a partida **não** é grande:
   `effective = max(base, piso - m.stars)`;
3. `> 5` → `Infinity`;
4. log (`piso`, `score` do round, `clipesHoje`) **só quando há autor**
   (player não vazio) — a consulta diagnóstica por round não pode virar
   spam.

O `m.stars` já está no closure. Falta `m.isBigMatch` (ver 7.3).

### 7.2 Camada 2 — tetos (`handleAce`, `src/main.ts`)

Logo depois do `hasAce` (linha ~710) e **antes** de OCR/cobertura/corte:

- contar clipes da partida (normal/grande) e do dia;
- estourou → `recordDiscardedEvent` com motivo `'cota da partida'` /
  `'cota do dia'` e `return` (mesmo padrão dos descartes de spread e
  cobertura);
- passou → segue o fluxo atual e, no `insertClip`, grava
  `kills: ace.kills.length`, `stars`, `isBig`, `floorBefore`, `minKills`.

Checar **antes** do corte é o ponto: um 4k bloqueado pelo teto não pode
gastar OCR nem render.

### 7.3 Detecção de partida grande

- `stage` **já é lido** do card (`hltvMonitor.ts`, `.match-stage`) mas fica
  só no `MatchCard` — não chega ao `LiveMatch`.
- Plano: `src/monitor/bigMatch.ts` com
  `isBigMatch({ stage, event, stars, watchlisted })` puro + exportar
  `isTopTierEvent(event)` a partir do `TOP_TIER_EVENTS` atual.
- `LiveMatch` ganha `stage?: string` e/ou `isBigMatch?: boolean`; o
  `onAce` propaga para o `AceEvent` (`stars?`, `big?`) ou para um 4º
  parâmetro de `handleAce`.

### 7.4 Funções puras (novo `src/clipper/clipLadder.ts`)

```ts
clipScore({ kills, stars }): number
dailyFloor({ clipsToday, bestScore, base, ceiling }): number
effectiveMinKills({ base, floor, stars, big }): number | null   // null = bloqueado
isBigMatch({ stage, event, stars, watchlisted }): boolean
clipBudgetDecision({ clipsToday, clipsInMatch, big, caps }): { allowed, reason? }
```

Sem I/O. O SQL e o `insertClip` ficam no chamador — regra do projeto.

---

## 8. Configuração nova

Todas opcionais, com defaults seguros; `CLIP_FLOOR_ENABLED=false` no
primeiro deploy para o código não mudar comportamento sozinho.

| Env | Default | Efeito |
|---|---|---|
| `CLIP_FLOOR_ENABLED` | `false` | liga o piso no `minKillsFor` |
| `CLIP_FLOOR_BASE` | `5` | piso antes do 1º clipe do dia |
| `CLIP_FLOOR_CEILING` | `8` | onde o piso satura |
| `CLIP_MAX_PER_MATCH` | `2` | teto de clipes normais por partida |
| `CLIP_MAX_BIG_PER_MATCH` | `3` | teto em partida grande |
| `CLIP_MAX_PER_DAY` | `6` | teto diário (cota do YouTube) |
| `CLIP_BIG_MIN_KILLS` | `4` | base de kills em partida grande |
| `CLIP_BIG_TOPTIER_MIN_STARS` | `3` | estrelas mínimas para evento top-tier contar como grande |
| `CLIP_FLOOR_IGNORE_WATCHLIST` | `true` | override explícito da watchlist fura o piso |

Chaves por canal: entram em `CHANNEL_SCOPED_KEYS` (BR e EN podem ter
volumes diferentes) e no `trayConfig.ts`/painel.

Preset **Equilibrado** (o que vai no `.env`):

```
CLIP_FLOOR_ENABLED=true
MIN_KILLS=4
MIN_KILLS_NO_STARS=4
RANK_MIN_KILLS=4
CLIP_FLOOR_BASE=5
CLIP_FLOOR_CEILING=8
CLIP_MAX_PER_MATCH=2
CLIP_MAX_BIG_PER_MATCH=3
CLIP_MAX_PER_DAY=6
```

Preset **Volume** (se um dia quiser começar em 3k): `MIN_KILLS=3`,
`RANK_MIN_KILLS=3`, `CLIP_FLOOR_BASE=3`, `CLIP_FLOOR_CEILING=7`.

---

## 9. Diagnóstico (sem isso o usuário não sabe por que o clipe não saiu)

- **Log** (`main.ts`, no tracker): `piso`, `clipesHoje`, `melhorScore`,
  `score` do round, `big`, `minKills` efetivo.
- **`npm run explain -- --match <id>`**: coluna nova por round —
  `4k/2★ = 6 · piso 7 → bloqueado pelo piso` / `4k/2★ = 6 · piso 7 · FINAL → liberado`.
- **`npm run diag:clip -- data/clips/<pasta>`**: mostra `score`, `big`,
  `floor_before` e `min_kills` do sidecar/DB.
- **`discarded_events.reason`**: `'piso do dia'`, `'cota da partida'`,
  `'cota do dia'` — entram no relatório de perdas que já existe.
- **Painel**: "piso do dia", "clipes hoje", "clipes desta partida".

---

## 10. Testes (funções puras, sem rede/credenciais)

`tests/clipLadder.test.ts`:

- `clipScore`: 3k/0★=3 … 5k/5★=10; estrelas ausentes/0.
- `dailyFloor`: sem clipes → `BASE`; `melhor+1`; satura no teto; teto
  alcançado → repete o topo; dia novo → volta ao `BASE`; clipes antigos
  sem score → `BASE + n` (fallback).
- `effectiveMinKills`: base 4/piso 3 → 4; piso 7/2★ → 5; piso 9/2★ →
  bloqueado; grande → ignora o piso; rank baixou para 4 e piso subiu para
  5 → 5.
- `isBigMatch`: final/semi/playoff; watchlist; top-tier 3★; top-tier 2★
  **não**; grupo de evento comum **não**.
- `clipBudgetDecision`: normal 2, grande 3, diário 6; shorts não contam.

`tests/db.test.ts` (ou equivalente): migração idempotente das colunas;
contagem ignora `is_shorts` e outro canal.

---

## 11. Fases de implementação

| Fase | Entrega | Muda comportamento? |
|---|---|---|
| 0 | este documento | não |
| 1 | colunas em `clips` + funções de leitura (`clipsHoje`, `melhorScore`) | não |
| 2 | `src/clipper/clipLadder.ts` + testes | não |
| 3 | piso no `minKillsFor` atrás de `CLIP_FLOOR_ENABLED` | não (flag off) |
| 4 | tetos no `handleAce` + gravação das colunas | não (flag off) |
| 5 | `explain`, `diag:clip`, painel, `README`, `.env.example` | não |
| 6 | `CLIP_FLOOR_ENABLED=true` + preset Equilibrado no `.env` | **sim** |
| 7 | observar 1 dia; calibrar `BASE`/`CEILING`/tetos | ajuste |

Rollback: `CLIP_FLOOR_ENABLED=false`. As colunas novas podem ficar (não
atrapalham) — não há migração destrutiva para desfazer.

Sequência operacional do projeto: `npm run lint` → `npm test` →
`npm run build` → `pm2 restart 5k-bot` (só quando o log mostrar `kept:0` /
sem recorder ativo).

---

## 12. Riscos e decisões abertas

1. **Estrelas desconhecidas (`stars=0`)** — o score cai para `kills` e o
   piso fica mais duro. Hoje 0★ só entra por rank/watchlist; aceitável.
   Alternativa (não recomendada): inferir por top-tier.
2. **Watchlist vs. piso** — recomendação: override explícito da watchlist
   **fura** o piso (`CLIP_FLOOR_IGNORE_WATCHLIST=true`), mas o clipe conta
   para o piso e para os tetos. É intenção explícita do usuário, como já
   acontece com o rank.
3. **Top-tier é amplo** — o regex atual pega ESL/BLAST/IEM de grupo. Por
   isso o critério exige `stars >= 3`; sem esse gate, quase toda partida
   seria "grande" e o piso perderia efeito.
4. **Equilibrado aumenta volume** (2★ 5k → 4k). O piso é o contrapeso —
   não ligar um sem o outro.
5. **Rank + piso** — uma partida que entrou pelo rank com 4k pode precisar
   de 5k se o dia já está cheio. É o desenho; o `explain` deixa isso
   visível.
6. **Cota do YouTube** — `CLIP_MAX_PER_DAY=6` é casado com
   `YT_QUOTA_UNITS_PER_DAY=10000`. Subir um exige subir o outro.
7. **Corrida entre trackers** — resíduo de 1 clipe, limitado pelo teto
   diário; não vale lock.
8. **Shorts** — sempre `is_shorts = 0` na contagem. O Short não é um
   clipe novo para a escada.

---

## 13. Por que não os modelos alternativos

- **Escada global sem reset**: em poucos dias só 5k/5★ qualifica e o canal
  para de publicar. Também pune o futuro (um 4k/1★ às 11h bloquearia um
  4k/2★ às 21h).
- **Escalada só dentro da partida**: cada partida recomeça do zero. Um dia
  com 5 partidas fracas ainda rende 5–10 clipes — não resolve o "não
  repetir 3k/0★" entre partidas.
- **Só subir `MIN_KILLS`**: transforma qualidade em quantidade de um jeito
  cego — um 4k/4★ (melhor) e um 4k/0★ (pior) têm o mesmo limiar, e o
  canal perde os clipes bons de partidas grandes.

O piso diário é o único que (a) reproduz a cadeia pedida, (b) reseta
sozinho, (c) abre a exceção da final e (d) tem estado derivável do banco.
