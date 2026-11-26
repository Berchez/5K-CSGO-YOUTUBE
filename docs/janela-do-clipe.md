# A janela do clipe — runbook

> **Este arquivo é a referência da janela de corte.** Qualquer defeito de
> "o clipe abriu no lugar errado" (abriu no replay, abriu depois da 1ª
> kill, fechou antes da última, atravessou a partida) tem o diagnóstico
> aqui. Leia-o ANTES de mexer no corte — e depois escreva o que
> aprendeu de volta aqui.
>
> Relatórios históricos: `docs/relatorio-investigacao-clipes.md`
> (o histórico completo até 30/10/2026). Este runbook é o **contrato
> vigente** + o procedimento; o relatório é a arqueologia.

---

## 1. Por que a janela é o defeito mais importante

O bot tem três saídas: o vídeo, a descrição e o banco. Só a primeira
não tem correção manual barata: um clipe publicado no YouTube com a
janela errada **não volta**. Os outros dois dá para consertar.

Por isso o corte tem uma regra assimétrica:

- **abrir cedo** custa alguns segundos de contexto — barato;
- **abrir tarde** perde a 1ª kill do ace — caro (é o defeito que mais
  voltou);
- **fechar tarde** custa um clipe mais longo — barato;
- **fechar cedo** perde a última kill — caro.

Toda decisão do corte segue isso. Quando duas regras se conflitam,
**abre cedo**.

## 2. Os três relógios (e por que a janela sai errada)

| Relógio | O que é | Onde vem | Erro típico |
|---|---|---|---|
| **Relógio do jogo** | o instante do kill | placar do HLTV (`KillEvent.at`) | `at` é o instante do **poll**, não do kill: atrasa 5..16s por kill |
| **Relógio do vídeo** | o instante no material gravado | mtime dos segmentos / `clipStartMs` | o vídeo chega atrasado da stream (a "latência") |
| **Relógio do bot** | o instante do processo | `Date.now()` | é o relógio de parede, não o do jogo |

A janela é a conversão entre o relógio do jogo e o do vídeo:

```
início no vídeo ≈ (at da 1ª kill − atraso do placar) + latência da stream
```

A latência **muda dentro da partida** (pausa do streamer, buffering,
catch-up, restart da fonte): 25s num round, 45s no seguinte. Um valor
fixo por canal erra dezenas de segundos.

Os erros não são simétricos: latência **estimada grande demais** = o
corte abre depois da 1ª kill (o defeito clássico).

## 3. O contrato da janela (invariantes)

Um clipe é o ace **se e somente se**:

1. **contém a 1ª kill** do ace;
2. **contém a última kill** do ace;
3. **não abre depois do fim do round no vídeo** — se o round já
   acabou, o material é replay e o ace não pode mais estar no clipe;
4. **a lista de kills é de UM round só** — o sinal mais forte é o
   `round` do próprio evento; na falta dele, o **intervalo entre kills
   consecutivas** (teto: `CLIP_KILLS_GAP_MAX_SEC`, 90s) e a dispersão
   total (teto: `CLIP_KILLS_SPREAD_MAX_SEC`, 120s). Um round lento
   (pós-plant/retake) passa de 60s entre a 1ª e a 5ª kill **sem** ser
   bug — por isso o limite é folgado e o intervalo pesa mais;
5. (quando o round ao vivo não está no buffer) o clipe é **marcado**
   como replay — último recurso, nunca o padrão.

A implementação é `auditClipWindow` (`src/clipper/clipWindowAudit.ts`),
função pura, testada em `tests/clipWindowAudit.test.ts`. A MEDIÇÃO do
MP4 renderizado (banner "REPLAY", killfeed do próprio clipe) está em
`src/clipper/clipWindowOcr.ts` — o mesmo código do bot e do harness.

### Onde cada invariante é checada

| Invariante | Onde | Quando |
|---|---|---|
| (4) lista de um round só | `suspectKillsSpread` — **antes** do corte | no `handleAce`, antes de gastar OCR |
| (1)(2)(3) janela | `auditClipWindow` — **depois** do render | guardrail: o clipe não vai ao YouTube se falhar |
| todas as kills do ace no MP4 final | `measureClipKillfeed` + `assessKillfeedCoverage` | upload automático exige todas as kills confirmadas, qualquer que seja `CLIP_VALIDATE` |
| placar do round alvo na abertura | `measureClipOpeningScore` + `assessOpeningScoreCoverage` | exige scoreBefore como primeira leitura e ao menos duas leituras nos primeiros 5s |
| (3) o clipe abre dentro de um replay | banner "REPLAY" no MP4 renderizado | no guardrail, nos 10 primeiros segundos do clipe |
| evidência (leu o vivo ou o replay?) | guarda de replay do killfeed | durante a varredura do killfeed |

### O modo do guardrail (`CLIP_VALIDATE`)

| modo | o que faz |
|---|---|
| `off` | pula OCR só quando `YT_UPLOAD=false`; com upload ligado a validação é obrigatória |
| `shadow` | observa quando não há upload; com upload ligado, bloqueia se faltar confirmação |
| `on` | valida sempre; em upload automático, bloqueia se a abertura ou as kills não forem confirmadas |

O descarte só acontece com evidência forte: o fim do round **medido**
(motivo `confident`, e não rejeitado pelos anchors) com o material ao
vivo disponível, ou a lista de kills misturando rounds, ou o banner de
replay no início do clipe. `after-only` e `gap-inferred` **não** são
medida do fim do round (o `gap-inferred` é um limite inferido) — usá-los
acusaria clipes bons de abrirem "depois do round".

O OCR do MP4 final localiza as kills no killfeed perto dos horários
previstos (tolerância de 15s) e compara cada leitura com o banner de replay.
Se uma kill esperada só aparece no replay, ou a primeira está encostada
no começo do arquivo, o bot volta aos segmentos congelados, inclui até
60s de contexto anterior e renderiza outra versão. Se a última kill está
ausente junto ao fim previsto ou só aparece no replay, estende a cauda em
passos de 15s, até 60s, e mede novamente. Isso tenta corrigir o render
antes de desistir. Cobertura parcial após as tentativas, OCR indisponível
ou leitura fora da janela retém a publicação; o vídeo e o evento permanecem locais.
O sidecar registra os índices e segundos encontrados, as leituras no
replay, os horários previstos, frames, crop e quantos milissegundos de
contexto anterior ou cauda foram adicionados nas reconstruções.
Separadamente, a primeira leitura legível deve ser o `scoreBefore` e os
primeiros 5 segundos devem conter ao menos duas leituras dele; se o
`scoreAfter` aparece primeiro, leituras posteriores do score anterior não
aprovam a abertura. Quando o OCR lê um placar, mas a abertura continua
ambígua, o bot reconstrói o MP4 15s mais cedo por tentativa, até 60s, e
mede de novo. Isso procura uma janela que realmente comece no round alvo,
em vez de abandonar a primeira tentativa. Sem nenhuma leitura útil, o
bot mantém o upload retido. O upload só segue se o MP4 final confirmar a
abertura e todas as kills. Material apenas de replay
também é retido, mesmo quando o evento está corretamente identificado como
replay. O score é comparado
sem ordem dos lados, para tolerar a troca CT/T; a correção fica em
`openingScoreValidation.startCorrectionMs`.

## 4. Anatomia de um clipe quebrado — os 6 sintomas

### S1 — "o clipe abre no replay e perde o round ao vivo"

**Sintoma**: o vídeo começa depois do round; o banner "REPLAY" está na
tela; o ace aparece só na reexibição.

**Causa raiz**: a âncora de início veio de uma leitura do killfeed feita
na **reexibição**. O replay repete as mesmas linhas do killfeed do
round, ~20..40s depois; lida como âncora, abre o clipe no replay.

**Caso de referência**: `2399858_Mirage_r15_makazze` (02/11/2026).

**Correção em vigor**:
- a guarda de replay (`CLIP_KILLFEED_REPLAY_CROP`, banner "REPLAY" do
  HLTV no canto superior esquerdo) marca as leituras feitas na
  reexibição e elas **não viram âncora**;
- uma âncora **não corroborada** (`first-kill-only`) não substitui a
  âncora do placar: o início é o **menor** entre as duas
  (`resolveClipStartAnchor`);
- sem âncora do killfeed, o **teto** de latência
  (`CLIP_START_LATENCY_MAX_MS`, 25s) limita a abertura, e o placar
  abre no round ao vivo.

### S2 — "a 1ª kill ficou de fora"

**Causa raiz**: latência estimada grande demais (sem medição do canal)
ou âncora tardia. **Correção**: teto de latência + margem de início
(`CLIP_START_MARGIN_SEC`) + contexto maior quando a âncora é
incerta (`CLIP_CONTEXT_UNCERTAIN_SEC`).

### S3 — "o clipe fecha antes da última kill"

**Causa raiz**: o fim estimado (placar + latência) chegou cedo demais.
**Correção**: piso do fim (`anchors.endFloorMs`), cauda
(`CLIP_END_TAIL_SEC`) e corte replay-aware.

### S4 — "o clipe tem 2 minutos e não é o ace"

**Causa raiz**: a lista de kills **misturou rounds** (o `at` é o poll:
atrasa 5..16s por kill; o tracker junta kills de rounds diferentes).
**Caso de referência**: `2399858_Ancient_r6_kyousuke` (3 kills de um
round, 2 de outro — 117s de dispersão e um intervalo de 114s entre
kills consecutivas).
**Correção em vigor**: `suspectKillsSpread` descarta o evento **antes**
do corte e registra em `discarded_events`. O descarte exige evidência
forte: `round` distinto no evento, intervalo entre kills consecutivas
> `CLIP_KILLS_GAP_MAX_SEC` ou dispersão > `CLIP_KILLS_SPREAD_MAX_SEC`.
Na faixa intermediária (round lento) o bot só **avisa** e segue.

### S5 — "o clipe abre no round anterior"

**Causa raiz**: a latência aplicada é pequena demais (o vídeo avança
mais rápido que o relógio do jogo) ou o replay-aware empurrou a
abertura. **Correção**: a âncora do placar usa a latência **medida** do
canal quando existe; sem medição, o teto impede a abertura precoce.

### S6 — "o clipe está congelado / sem imagem"

Não é janela: é material (buffer, freeze, disc timeline). Ver
`scripts/diag-buffer-av.ts` e `npm run diag:av`.

## 5. Como diagnosticar (o procedimento)

### 5.1 O harness (primeiro passo, sempre)

```bash
npm run diag:clip -- data/clips/2399858_Mirage_r15_makazze
npm run diag:clip -- --match 2399858 --ocr
```

O que ele imprime:

- as kills, a dispersão e o maior intervalo entre kills consecutivas;
- a latência aplicada/estimada e a fonte;
- a janela do clipe (início/fim);
- a âncora do killfeed e o motivo;
- o fim do round medido (**só o `confident` conta** como evidência) e o
  motivo da medição;
- as invariantes uma a uma;
- o **veredito** (`OK` / `DISCARD` / `REPLAY-ONLY`) e as violações;
- com `--ocr`: em que segundo do clipe cada kill do ace aparece no
  killfeed do próprio MP4 (ffmpeg em pipe + tesseract, sem escrever
  arquivo) e em que segundos o banner "REPLAY" aparece.

O `--ocr` é o que separa **round ao vivo** de **replay**: o replay
reaparece o killfeed — e o banner "REPLAY" está na tela. O OCR do
harness é o **mesmo código** do bot (`clipWindowOcr.ts`, com o mesmo
pré-processamento): um OCR diferente mediria outra coisa.

### 5.2 O log

O log (`logs/bot.log`) é JSON (pino), uma linha por evento. Os
mensagens que importam para a janela:

| Mensagem | O que diz |
|---|---|
| `multikill detectado` | quando o ace foi detectado (o relógio do bot) |
| `round over no placar` | quando o bot percebeu o fim do round |
| `placar do round não aplicado` | a calibração do placar falhou (motivo em `reason`) |
| `calibração pelo killfeed do vídeo` | a medição do killfeed: `motivo`, `casadas`, `candidatos`, `descartadas` |
| `âncoras do clipe (placar → vídeo)` | as âncoras finais e as latências aplicadas |
| `montando clipe` | o que o corte escolheu (segmentos, contexto, margens) |
| `clipe montado` | o trim real do MP4 |
| `latência do início limitada pelo teto` | o teto salvou a abertura |
| `janela do clipe fora das invariantes — clipe NÃO publicado` | o guardrail descartou |

Dica: o `grep` do shell não lê o `logs/bot.log` (encoding); use
`Select-String -LiteralPath` ou um script node que faça `JSON.parse`
linha a linha.

### 5.3 O sidecar

`data/clips/<pasta>/<pasta>.json` é o registro que **sobrevive ao
restart**. Desde o schema **v2** (`schemaVersion: 2`) os campos são
aninhados; sidecars antigos (v1, achatados) continuam legíveis — quem lê
usa `readClipSidecar` (`src/clipper/sidecar.ts`), que normaliza os dois
formatos no mesmo modelo.

| Campo (v2) | O que é |
|---|---|
| `clip.startMs`, `clip.durationSec` | a janela real do MP4 |
| `clip.file`, `clip.thumbnailFile` | os arquivos gravados |
| `sync.latency.startMs` / `.estimatedStartMs` / `.source` | a latência aplicada e a estimada |
| `sync.latency.configuredMs` | a latência configurada do canal |
| `sync.anchorSource` | `placar` / `killfeed` / `killfeed+placar` |
| `sync.killfeed.firstKillVideoMs` | a âncora lida no killfeed |
| `sync.killfeed.reason` | `confident` / `first-kill-only` / ... |
| `sync.killfeed.replayReads` | quantas leituras eram REPLAY (descartadas) |
| `sync.roundEndAt` | o fim do round **medido no vídeo** (ISO 8601) |
| `sync.reason` | o motivo da medição (`confident` é a única evidência forte) |
| `sync.killVideoOffsetMs` | `atMs + offset` = o instante da kill no vídeo |
| `window.killsSpreadMs` | a dispersão da lista de kills |
| `window.bufferOldestMs` | o início do material mais antigo disponível |
| `window.audit` | o veredito da auditoria (ação + violações) |
| `window.truncatedStart` | a âncora precede o buffer (abertura incompleta) |
| `window.end.minMs` / `.floorMs` / `.pinnedBy` / `.ocrRejected` | o fim do clipe e por que foi ancorado |
| `kills[]` | `atMs` (relógio do placar), `videoSec` (posição no clipe), `weapon`, `headshot` |
| `stats` | `killCount`, `weapons`, `headshots` (`null` = desconhecido), `mainWeapon` |
| `match`, `player`, `round` | confronto, jogador (com time/oponente) e round |

No v1 os mesmos dados vivem achatados (`clipStartMs`, `streamSync.*`,
`killsSpreadMs`, `clipWindowAudit`, `summary.*`); a normalização mapeia
um para o outro.

## 6. Decisões de projeto (para não discutir de novo)

1. **O menor entre as âncoras vence** (`resolveClipStartAnchor`).
   Abrir cedo é barato; abrir tarde perde a kill.
2. **Uma leitura única do killfeed não é confiança.** Só `confident`
   (≥2 kills no mesmo cluster, dentro de 2,5s) confirma a âncora.
3. **O replay é material válido, mas não é o ace.** O clipe só de
   replay é publicado **marcado** — o marcador vai para a DESCRIÇÃO
   (`(replay do round — o material ao vivo não estava no buffer)`), não
   só para o log: "publicado marcado" que só existe no log não é
   marcação nenhuma.
4. **Descarte destrutivo só com evidência forte**: lista de kills de
   rounds diferentes, ou fim de round **medido** (`confident`) no vídeo
   com o material ao vivo disponível, ou o banner de replay no início do
   clipe. Estimativa ruidosa vira aviso.
5. **O descarte é registrado** (`discarded_events`) — nada some sem
   registro.
6. **O teto de latência só existe para a abertura.** Para os
   timestamps da descrição não há lado barato: eles usam a estimativa.

## 7. Histórico de soluções (o que já foi tentado)

| # | Solução | Onde | Resultado | Rollback |
|---|---|---|---|---|
| 1 | Teto de latência de abertura (25s) | `CLIP_START_LATENCY_MAX_MS` | **funciona** — só para a abertura | `CLIP_START_LATENCY_MAX_MS=0` |
| 2 | Contexto maior com âncora incerta | `CLIP_CONTEXT_UNCERTAIN_SEC` | **funciona** | — |
| 3 | Margem de início | `CLIP_START_MARGIN_SEC` | **funciona** | — |
| 4 | Âncora do killfeed (leitura direta) | `killfeedSync.ts` | **funciona quando corroborada**; sem corroboração, era a fonte do defeito do replay | — |
| 5 | Calibração pelo placar no vídeo | `scoreboardSync.ts` | **parcial** — reason `no-transition` é frequente (o placar não expõe o timer) | — |
| 6 | Fim replay-aware (corta no replay) | `clipBuilder.ts` | **funciona** — corta a cauda do replay | `REPLAY_AWARE=off` |
| 7 | Piso do fim pela última kill | `anchors.endFloorMs` | **funciona** | — |
| 8 | Cobertura estrita (descarta sem footage) | `CLIP_COVERAGE_STRICT` | **funciona** — descarta o que não tem material | `CLIP_COVERAGE_STRICT=false` |
| 9 | Latência adaptativa por canal/round | `streamLatency.ts` | **funciona** — só quando há medição | `CLIP_STREAM_SYNC_ADAPTIVE=false` |
| 10 | Guarda de replay no killfeed (banner "REPLAY") | `CLIP_KILLFEED_REPLAY_CROP` | **funciona** (novo, 02/11/2026) | `CLIP_KILLFEED_REPLAY_CROP=` |
| 11 | Âncora = menor entre killfeed e placar | `resolveClipStartAnchor` | **funciona** (novo, 02/11/2026) | — |
| 12 | Descarte por dispersão de kills | `suspectKillsSpread` | **funciona** (novo, 02/11/2026) — o limite de 60s accusava round lento; hoje o descarte exige `round` distinto, intervalo > 90s ou dispersão > 120s | `CLIP_KILLS_SPREAD_MAX_SEC=300`, `CLIP_KILLS_GAP_MAX_SEC=300` |
| 13 | Guardrail pós-render (não publica janela inválida) | `CLIP_VALIDATE` + gate obrigatório no upload | upload automático não pode ser liberado por `off`/`shadow`; sem upload, esses modos continuam úteis para diagnóstico | `CLIP_VALIDATE=off` |
| 14 | Calibração do killfeed pelo cluster corroborado | `estimateStreamOffset` | **funciona** — mede latência real | — |
| 15 | Calibração do placar com transition | `scoreboardSync.ts` | **falhou** — o placar do HLTV não expõe o timer da rodada; o `reason` ficou `no-transition` na maioria dos rounds | revertido |
| 16 | Âncora do placar lida do frame "Round over" | `scoreboardSync.ts` | **parcial** — o frame aparece tarde (após o fim do round) | mantido em shadow |
| 17 | Fim de round só como evidência quando `confident` | `trustedRoundEndVideoMs` | **funciona** (novo, 02/11/2026) — `after-only`/`gap-inferred` acusavam clipes bons | — |
| 18 | Banner "REPLAY" lido no MP4 renderizado | `clipWindowOcr.ts` | **funciona** (novo, 02/11/2026) — a evidência independente que nenhuma conta de latência dá | `CLIP_VALIDATE=off` |
| 19 | Crop do banner por canal + aviso de crop inválido | `CLIP_KILLFEED_REPLAY_CROP_BY_STREAM` | **funciona** (novo, 02/11/2026) — crop errado desligava a guarda em silêncio | — |
| 20 | Cobertura temporal do killfeed no MP4 final antes do upload | `measureClipKillfeed` + `assessKillfeedCoverage` | upload automático bloqueia kills ausentes, fora de 15s ou OCR inconclusivo; mantém artefatos para revisão (novo, 24/11/2026) | `CLIP_VALIDATE=shadow` |
| 21 | Placar esperado presente na abertura do MP4 | `measureClipOpeningScore` + `assessOpeningScoreCoverage` | primeira leitura tem de ser o placar anterior, com duas leituras nos 5s iniciais; início tardio comprovado: reconstrói em passos de 15s até 60s e mede de novo | `CLIP_VALIDATE=shadow` |
| 22 | Auditoria retrospectiva da abertura dos clipes locais | `scripts/audit-clip-openings.ts` | leitura somente. Dos 97 clipes com placares esperados (26/11/2026), 17 `verified`, 5 `late`, 75 `unverifiable`; um clipe e duas pastas auxiliares não tinham os dados necessários | — |
| 23 | Reconstrução automática do início e da cauda conforme OCR do MP4 | `src/main.ts` | até 60s de contexto anterior quando a abertura/1ª kill falha; até 60s de cauda quando a última kill fica junto ao fim ou só aparece no replay; cada render é medido novamente | — |

> **Regra ao tentar uma solução nova**: uma linha na tabela acima, com o
> resultado honesto ("funciona" / "parcial" / "falhou") e como reverter.
> Sem isso, a próxima investigação repete o mesmo experimento.

## 8. Checklist de review (antes de dar o corte como pronto)

- [ ] o início é o **menor** entre as âncoras?
- [ ] a âncora do killfeed foi **corroborada** (`confident`)? Se não,
      o placar (com o teto) está abrindo?
- [ ] a guarda de replay está ativa (`CLIP_KILLFEED_REPLAY_CROP`, ou o
      crop do canal)? As leituras de replay estão fora dos candidatos?
- [ ] a dispersão das kills cabe no teto e o intervalo entre kills
      consecutivas também?
- [ ] o log mostra **os candidatos** (não só o resultado)?
- [ ] a validação visual está registrada no sidecar? Quando `YT_UPLOAD=true`,
      `off` e `shadow` também bloqueiam qualquer janela não confirmada.
- [ ] o sidecar registra `window.audit.killfeedValidation` como `verified`
      e as ocorrências estão até 15s dos horários previstos?
- [ ] o sidecar registra `window.audit.openingScoreValidation` como
      `verified`, com `scoreBefore` na primeira leitura e pelo menos duas
      leituras nos primeiros 5s?
- [ ] o sidecar tem `anchorSource`, `killfeedReason`, `roundEndAt`,
      `bufferOldestMs` e `clipWindowAudit`?
- [ ] `npm run lint` + `npm test` + `npm run build` passam?

## 9. Glossário

| termo | significado |
|---|---|
| âncora | o instante (no relógio do vídeo) que abre ou fecha o clipe |
| latência | quanto o vídeo da stream atrasa em relação ao jogo |
| offset | `instante no vídeo − instante no jogo` (medido pelo killfeed) |
| poll | a leitura do HLTV; o `at` da kill é o instante do poll |
| cluster | conjunto de leituras do killfeed com o mesmo offset |
| replay | a reexibição do round (o material já acabou) |
| truncado (`truncatedStart`) | a âncora precede o buffer: abertura incompleta |
| sidecar | o `.json` ao lado do MP4, o registro do corte |

## 10. Caso de referência (leia antes de "corrigir" de novo)

**`2399858_Mirage_r15_makazze`** — IEM Beijing 2026, Mirage, r15.

| fato | valor |
|---|---|
| ace detectado | 13:18:43.241 (relógio do bot) |
| round over (bot) | 13:18:33.228 |
| 1ª kill (`at` do placar) | 13:18:15.156 |
| calibração do killfeed | 13:22:16.468 (**3m33s** depois do ace) |
| motivo da calibração | `first-kill-only` (2 casadas, 1 fora do cluster) |
| âncora do killfeed | 13:18:57.486 — **a linha do REPLAY** |
| latência aplicada | 45.000ms (o teto foi dispensado: "killfeed ancorou") |
| clipe | 13:18:42.487 → 13:19:31.240 (48,75s) |
| o que o clipe mostra | o fim do round ao vivo e o replay ("REPLAY" na tela a partir de ~t=18s) |

**A cadeia do defeito** (vale como modelo de análise):

1. o ace foi detectado às 13:18:43 e o pipeline gastou **3m33s** em
   OCR (o placar primeiro, o killfeed depois);
2. a varredura do killfeed achou a linha da 1ª kill **na reexibição**
   (13:18:57) — a leitura ao vivo não casou;
3. como a leitura era única, o motivo foi `first-kill-only` — e o código
   tratava âncora do killfeed como **exata**, dispensando o teto de
   latência e sobrepondo a âncora do placar;
4. o clipe abriu 22s **depois** da 1ª kill real.

**O que o conserta** (tudo implementado em 02/11/2026):

- a guarda de replay marca a leitura e ela não vira âncora;
- `first-kill-only` não substitui a âncora do placar;
- sem âncora do killfeed, o teto (25s) limita a abertura → o clipe
  abre em 13:18:20, **antes** da 1ª kill ao vivo;
- o log passa a mostrar os **candidatos** (com o que foi descartado e
  por quê);
- o guardrail pós-render impede a publicação de uma janela inválida.

### Auditoria de 26/11/2026 — round errado confirmado pelo placar

A varredura de `data/clips` usou o placar do próprio MP4 nos primeiros
10s, sem alterar os artefatos. Ela encontrou 5 aberturas comprovadamente
tardias: `2400577_Cache_r12_VINI` (6-6, esperado 6-5),
`2400577_Cache_r21_chelo` (11-10, esperado 10-10),
`2400498_Nuke_r2_NAF` (2-0, esperado 1-0),
`2400498_Nuke_r4_NAF` (4-0, esperado 3-0) e
`2399855_Ancient_r6_Techno` (3-3, esperado 3-2). Em cada caso, o
placar posterior apareceu pelo menos duas vezes e o anterior não apareceu.

No Techno, o log registrou início em `04:34:13.141Z`, 45s após o
`aceStart` `04:33:28.141Z`, com latência configurada de 45s. Isso é
compatível com a imagem do placar 3-3 no começo do MP4. Os clips NAF
confirmam o padrão relatado antes: o round do evento é anterior ao round
que abre no vídeo.

O MP4 original do VINI começa no placar 6-6, já no round 13; o sidecar
esperava abrir no 6-5 durante o round 12. Os segmentos da captura Gaules
listados no sidecar não existem mais no buffer nem nos dois checkouts
locais. Foi localizado, porém, um VOD alternativo da transmissão PGL
Maincast (`2jtDi1QBcLk`), suficiente para reconstruir o conteúdo do round.

A leitura frame a frame do VOD muda o diagnóstico do evento: VINI mata
malbsMd e EliGE no mesmo instante, depois mata NAF. A linha posterior é
`JT → decenty`; a linha `noway + saadzin → Jorko` também não é kill do VINI.
Assim, o round contém **3 kills do VINI**, não as 4 atribuídas pelo
scorebot. A quarta kill veio do pareamento de placar com outro jogador no
mesmo round. O MP4 original abre no round seguinte e não mostra esse 3K.

Foi gerado, sem sobrescrever o MP4 original, o arquivo
`data/clips/2400577_Cache_r12_VINI/2400577_Cache_r12_VINI_RECOVERED_3K_PGL.mp4`:
62s do VOD PGL em 1080p, incluindo o round, as três kills e o encerramento.
O OCR confirma `VINI → malbsMd`, `VINI → EliGE` e `VINI → NAF`, e não
confirma `VINI → JT`. O registro local do banco tem `youtube_video_id`
nulo; não há vídeo publicado associado a substituir. O original fica
preservado como evidência do corte errado.

O guardrail pós-render bloqueia essa classe de falha quando o feed do
próprio vídeo não confirma todas as kills esperadas. Ele não corrige o
pareamento de vítimas no scorebot; a recuperação demonstra que isso é um
problema de integridade do evento além da janela temporal e pede auditoria
própria da associação killer/vítima.

Dos 97 clipes com `scoreBefore` e `scoreAfter`, 17 tiveram o placar
anterior confirmado, 5 começaram no placar posterior e 75 ficaram
inconclusivos por falta de leitura OCR confiável. Um clipe não tinha os
placares no sidecar e duas pastas eram auxiliares. Inconclusivo não quer
dizer correto: a validação agora segura o upload nesses casos até haver
confirmação.

### Auditoria do acervo local e dos uploads — 26/11/2026

Além da abertura, o harness `diag-clip-window.ts --ocr` leu 97 MP4s
locais em `data/clips` (1 frame/s, killfeed do clipe e banner de replay).
O relatório integral foi salvo temporariamente fora do repositório durante
a auditoria. Ele indicou 10 violações estruturais calculadas pelas âncoras
dos sidecars e 6 clipes que começam com o banner `REPLAY`; Xant3r aparece
nos dois grupos. A leitura OCR é evidência para revisão, não prova
independente de cada kill: o erro de segmentação do Tesseract e os crops
antigos aparecem em vários clipes.

**Violações estruturais** (a última kill prevista fica depois do fim do
arquivo, salvo indicação):

| Clipe | Resultado da auditoria | ID YouTube / estado observado em 26/11 |
|---|---|---|
| `2399756_Cache_r14_Xant3r` | replay no início e janela estruturalmente inconsistente | sem ID no banco |
| `2399756_Cache_r4_ZywOo` | fecha antes da última kill prevista | sem ID no banco |
| `2399756_Cache_r8_robo` | fecha antes da última kill prevista | sem ID no banco |
| `2399756_Cache_r9_ZywOo` | fecha antes da última kill prevista | sem ID no banco |
| `2399858_Ancient_r6_kyousuke` | intervalo de 114s entre kills; evento mistura rounds | `mj1Ah9CDeLU`, não listado |
| `2399948_Inferno_r18_saadzin` | abre depois da primeira kill prevista | `oqklfyUjEpQ`, não listado |
| `2399949_Mirage_r13_biguzera` | termina 4,8s antes da última kill prevista | `EPfqvM-Ul6Q`, público |
| `2400208_Ancient_r18_donk` | termina 28,2s antes da última kill prevista | `JPVkRrzLOnY`, público |
| `2400208_Ancient_r19_magixx` | termina antes da última kill prevista | `D_NLtgyzq-s`, não listado |
| `2400359_Ancient_r13_KusMe` | termina antes da última kill prevista | `W5AtV9s8Ct0`, não listado |

**Banner de replay no começo** (fora a linha Xant3r já listada):

| Clipe | ID YouTube / estado observado em 26/11 |
|---|---|
| `2399851_Mirage_r20_YEKINDAR` | sem associação correspondente no banco |
| `2399855_Dust2_r7_nin9` | `fY2jzXKxfCo`, não listado |
| `2399857_Dust2_r10_yuurih` | `seoztTd1lGk`, não listado |
| `2399857_Dust2_r14_FalleN` | `P47X_z7VZjE`, não listado |
| `2399996_Cache_r23_YEKINDAR` (Short) | `2IIlT1udjEQ`, público |

O teste externo de disponibilidade confirmou 84 dos 104 IDs de vídeo; os
outros 20 estão privados e nenhum tem cópia local. Também foram confirmadas
aberturas tardias nos 3 casos com upload: NAF `r2` (`jDulVvGDAbg`, não
listado), NAF `r4` (`Ta8bj_wcqb8`, não listado) e Techno `r6`
(`-6bWjs_aox4`, não listado). Somando esses casos aos 10 estruturais e aos
5 inícios em replay, 13 IDs têm defeito de janela confirmado; 3 estão
públicos e 10 não listados. O status foi consultado com `yt-dlp`; o campo
`privacy` do SQLite é só o registro local, não a fonte da visibilidade
atual.

Os 2 vídeos locais adicionais em `data/clips-vod` foram revistos no MP4
original: Mirage r17 e Nuke r5 do YEKINDAR mostram as quatro vítimas
esperadas na jogada ao vivo antes do replay. Cinco vídeos públicos antigos
sem arquivo ou sidecar local tiveram apenas a abertura examinada; não havia
banner de replay nos primeiros 12s, mas sem o sidecar não foi possível
validar o round e todas as kills.

Limite desta auditoria: 306 dos 413 registros do banco apontam para um
arquivo ausente; 20 vídeos privados não têm cópia local; e 75 dos 97
sidecars com placar esperado não puderam confirmar scoreBefore nem
scoreAfter por OCR. Portanto, este relatório identifica defeitos
confirmados e protege novas publicações, mas **não prova que todo o arquivo
histórico esteja correto**. Os 3 vídeos públicos defeituosos continuam no
YouTube: nenhuma visibilidade foi alterada durante esta auditoria.

## 11. Onde mexer

| o quê | arquivo |
|---|---|
| invariantes e veredito | `src/clipper/clipWindowAudit.ts` |
| medição do MP4 renderizado (banner/killfeed) | `src/clipper/clipWindowOcr.ts` |
| âncora de início (regra do menor) | `src/clipper/clipAnchors.ts` (`resolveClipStartAnchor`) |
| varredura do killfeed + guarda de replay | `src/clipper/killfeedSync.ts` |
| pipeline do ace (âncoras, guardrail, descarte) | `src/main.ts` (`handleAce`) |
| sidecar | `src/clipper/clipBuilder.ts` (`buildSidecar`, `patchSidecarAudit`) |
| marcador de replay na descrição | `src/uploader/videoMetadata.ts` (`composeDescription`) |
| knobs | `src/config.ts` (`CLIP_*`) |
| harness | `scripts/diag-clip-window.ts` (`npm run diag:clip`) |
| testes | `tests/clipWindowAudit.test.ts`, `tests/killfeedSync.test.ts` |
