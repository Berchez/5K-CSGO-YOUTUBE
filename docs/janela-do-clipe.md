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
| (3) o clipe abre dentro de um replay | banner "REPLAY" no MP4 renderizado | no guardrail, nos 10 primeiros segundos do clipe |
| evidência (leu o vivo ou o replay?) | guarda de replay do killfeed | durante a varredura do killfeed |

### O modo do guardrail (`CLIP_VALIDATE`)

| modo | o que faz |
|---|---|
| `off` | não valida |
| `shadow` | valida, LOGA e grava no sidecar, mas **não descarta** (vigia a regra antes de ela custar um clipe) |
| `on` | valida e **descarta** o clipe fora das invariantes (o descarte é destrutivo: o ace sai do banco) |

O descarte só acontece com evidência forte: o fim do round **medido**
(motivo `confident`, e não rejeitado pelos anchors) com o material ao
vivo disponível, ou a lista de kills misturando rounds, ou o banner de
replay no início do clipe. `after-only` e `gap-inferred` **não** são
medida do fim do round (o `gap-inferred` é um limite inferido) — usá-los
acusaria clipes bons de abrirem "depois do round".

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
restart**. Campos que descrevem a janela:

| Campo | O que é |
|---|---|
| `clipStartMs`, `clipDurationSec` | a janela real do MP4 |
| `startLatencyMs`, `estimatedStartLatencyMs`, `latencySource` | a latência aplicada e a estimada |
| `streamSync.anchorSource` | `placar` / `killfeed` / `killfeed+placar` |
| `streamSync.killfeedFirstKillVideoMs` | a âncora lida no killfeed |
| `streamSync.killfeedReason` | `confident` / `first-kill-only` / ... |
| `streamSync.killfeedReplayReads` | quantas leituras eram REPLAY (descartadas) |
| `streamSync.roundEndAt` | o fim do round **medido no vídeo** (ISO 8601) |
| `streamSync.reason` | o motivo da medição (`confident` é a única evidência forte) |
| `killsSpreadMs` | a dispersão da lista de kills |
| `bufferOldestMs` | o início do material mais antigo disponível |
| `clipWindowAudit` | o veredito da auditoria (ação + violações) |
| `truncatedStart` | a âncora precede o buffer (abertura incompleta) |

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
| 13 | Guardrail pós-render (não publica janela inválida) | `CLIP_VALIDATE` | **funciona** (novo, 02/11/2026) — `off`/`shadow`/`on` (o `auto` era igual ao `always`) | `CLIP_VALIDATE=off` |
| 14 | Calibração do killfeed pelo cluster corroborado | `estimateStreamOffset` | **funciona** — mede latência real | — |
| 15 | Calibração do placar com transition | `scoreboardSync.ts` | **falhou** — o placar do HLTV não expõe o timer da rodada; o `reason` ficou `no-transition` na maioria dos rounds | revertido |
| 16 | Âncora do placar lida do frame "Round over" | `scoreboardSync.ts` | **parcial** — o frame aparece tarde (após o fim do round) | mantido em shadow |
| 17 | Fim de round só como evidência quando `confident` | `trustedRoundEndVideoMs` | **funciona** (novo, 02/11/2026) — `after-only`/`gap-inferred` acusavam clipes bons | — |
| 18 | Banner "REPLAY" lido no MP4 renderizado | `clipWindowOcr.ts` | **funciona** (novo, 02/11/2026) — a evidência independente que nenhuma conta de latência dá | `CLIP_VALIDATE=off` |
| 19 | Crop do banner por canal + aviso de crop inválido | `CLIP_KILLFEED_REPLAY_CROP_BY_STREAM` | **funciona** (novo, 02/11/2026) — crop errado desligava a guarda em silêncio | — |

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
- [ ] o guardrail pós-render está ligado (`CLIP_VALIDATE`)? Em `shadow`
      ele registra a violação sem publicar errado.
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
