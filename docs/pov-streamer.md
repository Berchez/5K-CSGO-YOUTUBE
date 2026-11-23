# Modo POV (streamer próprio) — medição e proposta

> **Status:** proposta de desenho. **Nada implementado.** Este documento
> registra (a) a medição que responde "o OCR atual serve para POV?", feita
> num round real de um streamer em Premier, e (b) o desenho mínimo de um
> modo novo, se e quando o teste de aceitação (§9) passar.
>
> Não confundir com o plano de `docs/clipes-incrementais.md` (piso diário):
> aquele é sobre **quantos** clipes publicar de uma partida da HLTV; este é
> sobre uma **fonte de evento diferente** — a própria stream do jogador.

---

## 1. A pergunta

O bot hoje detecta 4K/5K em partidas **da HLTV** (torneio). O pedido era
saber se ele atende um caso de uso diferente:

- streamer **não profissional** jogando **Premier** (partida que não existe
  na HLTV);
- **ao vivo**, a partir da stream dele;
- clipe da **reação** (voz + webcam), não só do frag.

Isso não é um ajuste de filtro. É trocar a **fonte de verdade**: hoje o
detector é o DOM da HLTV (placar + scorebot) e o OCR do killfeed é só
enriquecimento. No POV não existe DOM, não existe scorebot, não existe
`matchId` — sobra o vídeo da stream.

---

## 2. Veredito

**Com o pipeline atual, não atende.** Não por causa de crop ou de resolução:
porque o killfeed passaria de *enriquecimento* a *detector único*, e ele não
tem precisão para isso.

O que mudou de fato com a medição:

| Peça | Situação | Consequência |
|---|---|---|
| Relógio do round (timer/placar do topo) | **funciona** (~100% com filtro de monotonicidade) | dá para saber quando o round começa/acaba |
| Killfeed — "o streamer matou" | **funciona por linha** (4/4 no round medido), não por segundo (~44%) | exige matcher mais tolerante que o atual |
| Killfeed — "quem ele matou" | **falha** em nomes curtos (`jSt`, `mTh1`, `R10`) | não dá para deduplicar por vítima |
| Aquisição da stream, áudio, buffer | **já existe** e serve sem mudança | latência de detecção deixa de ser problema |

Ou seja: dá para construir **um contador de kills do streamer por round** com
confiança média, e **não** dá para construir um verificador de 4K/5K com
confiança alta. A diferença entre os dois é exatamente o que o bot vende hoje
("4K de verdade, sem falso positivo").

O desenho proposto em §7 assume isso: modo separado, **fila de revisão**,
nunca publicação automática.

---

## 3. Como foi medido

Material: trecho de 160 s do VOD público do steelega
(`youtube.com/watch?v=CT-YzxtIIe8`), 1920×1080, H.264, contendo um round com
**3K** confirmado (round começa em 1:21:33 do VOD). O round medido:

- timer `1:55 → 1:12` (round deu **vitória por eliminação** com 1:12 no
  relógio, painel "VITÓRIA DA TEAM STEELEGA" na tela);
- as três kills do steelega, lidas do killfeed a olho:
  1. `steelega + Prata → jSt`
  2. `steelega → mTh1` (AUG)
  3. `steelega + Prata → R10` (FAMAS)

Método (o mesmo pré-processamento do bot, `scripts/ocr-probe.ts` e variantes
descartáveis):

- ffmpeg extrai crops a **1 fps**;
- `sharp`: grayscale + normalize + upscale 3× (largura ~1.700 px);
- tesseract.js `eng`, `PSM.SINGLE_LINE` (uma linha por crop);
- slots fixos de uma linha do killfeed (`x≈0,705`, `y≈0,065`, altura
  `0,033` do frame).

Duas medições separadas: **timer/placar** (crop do topo, whitelist de
dígitos) e **killfeed** (4 slots verticais × 1 fps).

> **Amostra = 1 round, 1 streamer.** Serve para decidir "vale investir no
> teste de aceitação?", não para estimar taxa de produção. Os números abaixo
> têm essa margem.

---

## 4. Os números

### 4.1 Relógio do round

Crop do timer no topo, whitelist `0123456789:`, 1 fps, 65 amostras:

- **43 de 44 s** do round vivo lidos corretamente (`1:55 → 1:12`, sequência
  contínua);
- **1 glitch** (`1:29` → `1:23`), isolado, cercado por leituras corretas;
- os vazios das 65 amostras coincidem com o **fim do round** (painel de
  vitória esconde/escurece o timer) e com o freeze time seguinte (`0:15`).

Como a sequência é monotônica, um filtro de plausibilidade ("só aceito
`t-1 ≤ leitura ≤ t`") transforma 43/44 em **100% utilizável**: o glitch é
rejeitado, não propagado.

Placar `5-9` lido como `59` em ~50 de 54 amostras — suficiente para detectar
**mudança de round**, não para confiar no placar.

**Conclusão:** a peça que a HLTV fornece de graça (quando o round começa e
acaba) é a peça que o OCR do POV faz melhor. Isso é o que torna o modo POV
pensável.

### 4.2 Killfeed por segundo (o número ruim)

Segundos em que uma linha do steelega estava na tela × segundos em que o OCR
devolveu o nome reconhecível (distância de edição ≤ 2):

| Linha | Na tela | Nome lido | Taxa |
|---|---|---|---|
| `steelega + Prata → jSt` | ~4 s | 3 | 75% |
| `steelega → mTh1` | ~9 s | 3 | 33% |
| `steelega + Prata → R10` | ~5 s | 2 | 40% |
| **total** | **~18 s** | **8** | **~44%** |

Leituras reais do mesmo nome no mesmo round:

```
steslega   stesliega   stesioga   stealega   steselega   wetesloga   sist
```

Nenhuma linha do killfeed é estável: a cada segundo o OCR erra de um jeito
diferente. O que salva o detector é a **redundância temporal** — a linha fica
4–9 s na tela, então "leu pelo menos uma vez" é bem mais provável que "leu
naquele segundo".

### 4.3 Killfeed por linha (o número que importa)

- **4 de 4 linhas** do round foram detectadas ao menos uma vez (as 3 do
  steelega + a de um companheiro, `yelzao → Klaus 16y`).
- **0 de 3 vítimas** curtas foram lidas: `jSt` → `JSt`/`sist`/`JF B`,
  `mTh1` → nunca, `R10` → nunca.

Isso define o desenho: **dá para contar "o streamer matou", não dá para saber
quem**. Contagem por vítima (como `hasAce` faz na HLTV) está fora; a contagem
tem que ser por **transição de slot** (§7.3).

### 4.4 Nomes longos × curtos

O padrão não é aleatório:

| Nome | Resultado |
|---|---|
| `steelega` (8) | lido, com 1–2 caracteres trocados |
| `Prata` (5) | lido |
| `Volodymyr TOGOAT` (16) | lido (`Volodvmvr TOGOAT`) |
| `yelzao` (6) | lido (`yeizao`) |
| `jSt` (3), `mTh1` (4), `R10` (3) | **nunca** |

O matcher atual não cobre isso:
`src/clipper/killfeedSync.ts` usa `NICKNAME_MAX_DISTANCE = 1`, e
**distância 0 para alvos de até 3 caracteres**. Calibrado para o killfeed do
broadcast, esse limite rejeita `stesliega`/`stesioga`/`wetesloga` — ou seja,
**a terceira kill do 3K medido não teria sido detectada** com o matcher de
hoje, mesmo estando legível na tela.

Consequência direta: reusar `killfeedSync` como está **subestima** a contagem.
Qualquer modo POV precisa de uma política de distância própria (provável:
`≤2` para nomes ≥6 letras, mais validação por múltiplas leituras).

### 4.5 Custo

Uma passada de 4 slots × 1 fps = **4 OCR/s** por stream, ~50–130 ms cada
(medido). Isso é ~0,3–0,5 de um núcleo **por streamer, contínuo, 24/7**.
Aceitável para 1 canal; não escala para vários sem fila de workers.

Comparação: o bot hoje faz OCR **por clipe** (janela de ~1 min, alguns
frames), não contínuo. É uma mudança de perfil de custo, não só de código.

### 4.6 O que a medição também mostrou (e o runbook não cobre)

- **OCR do bloco inteiro não funciona.** `SPARSE_TEXT` sobre o retângulo
  todo do killfeed devolve lixo, porque o fundo é o mapa. Só o crop de
  **uma linha** funciona. Na HLTV o mesmo problema existe, mas lá o OCR do
  killfeed é só enriquecimento — pode falhar.
- **O killfeed sobrevive ao fim do round.** No painel "VITÓRIA" as três
  linhas ainda estavam na tela. Isso permite uma **segunda passada** no fim
  do round (killfeed completo, mais tempo por linha) — o análogo do
  `SCOREBOT_LATE_ENRICH_SEC`. Mas o bloco guarda só as ~5 últimas linhas,
  então essa passada valida o **fim** do round, não o round inteiro.
- **A ordem do killfeed é: mais recente em cima.** O contador pode explorar
  isso (nova kill = slot 1 novo), mas qualquer linha empurrada para fora da
  área visível por 2+ kills rápidas se perde.

---

## 5. Por que o papel do OCR muda tudo

Na HLTV, o bot tem **duas fontes independentes** (placar do DOM + scorebot) e
o OCR só acrescenta arma/HS/assistência. Erro do OCR = campo `undefined`,
nunca clipe errado. O `AGENTS.md` é explícito: campo ausente fica
`undefined`, **nunca** `false`.

No POV, o OCR é a **única** fonte. Um erro não vira `undefined`, vira
**contagem errada** — e, no fim da cadeia, um clipe publicado com o rótulo
errado, que não volta. A direção do erro também é ruim: perder uma linha
transforma 4K em 3K e 5K em 4K, e o resultado passa em qualquer filtro de
qualidade.

O guardrail que existe hoje (`CLIP_VALIDATE=on`, `docs/janela-do-clipe.md`)
não cobre isso: ele valida a **janela**, não a **contagem**.

---

## 6. O que já serve sem mudança

| Peça | Estado | Observação |
|---|---|---|
| Captura | `StreamRecorder` aceita qualquer `streamUrl` via `yt-dlp -g` | trocar a URL da HLTV pela URL do canal é o menor dos problemas |
| Áudio | `capturePlan()` mapeia `0:v` + `0:a`, muxed | a **reação** (voz) sobrevive ao clipe |
| Buffer | 24 segmentos × 10 s = **240 s** | detecção pode levar minutos; não precisa ser tempo real |
| Pré/pós-roll | `CLIP_PRE_ROLL_SEC=60`, `CLIP_POST_ROLL_SEC=15` | o pós-roll já cobre a reação |
| Corte/render/thumb/Shorts | consomem `AceEvent` + `LiveMatch` | `buildTitle` usa só strings (`player`, `team1`, `event`, `map`, `round`) |
| Banco | `ace_events` / `clips` com `channel_id` | dedup e cota já são por canal |
| Sidecar | `writeClipSidecar()` atômico | v2 aceita `kills[]` incompleto (`atVodSec` presente, `at` ausente) |

O acoplamento real com a HLTV é pequeno e localizado:
`fetchMatchStreams(matchPageUrl)` (linha ~2466 do `src/main.ts`) e
`trackMatch(matchPageUrl, matchId)`. Num modo POV a URL/`matchId` são
sintéticos e essas duas chamadas saem do caminho.

---

## 7. Desenho mínimo proposto

### 7.1 Modo e isolamento

- **Canal próprio**, não flag no runtime HLTV. Um processo por streamer,
  `streamUrl` fixo no `.env`, `channel_id` próprio (`CHANNELS=br,<canal>`).
- O canal não-default já é **fail-closed** e isolado (`channelIsolationErrors`,
  `docs/multi-canal.md`): diretórios, tokens e cota separados. Encaixa sem
  inventar mecanismo novo.
- `LiveMatch` sintético: `matchId = pov:<canal>:<yyyy-mm-dd>`,
  `team1 = <streamer>`, `team2 = "Premier"`, `event = "Premier"`,
  `stars = 0`, `isTopTierGuess = false`, `matchPageUrl = <url da stream>`.
- Título próprio (`buildTitlePov`): `4K! <streamer> (<arma>) — Premier <mapa> R<n>`
  — `buildTitle` atual geraria `steelega vs Premier`.

### 7.2 Fonte de eventos

```
timer do topo (1 fps, whitelist de dígitos)
  └─ validação por monotonicidade → início/fim de round

killfeed (4 slots × 1 fps)
  └─ offset vertical derivado da resolução + calibração por canal
```

- Sem timer legível por N segundos → **não corta** (não adivinha round).
- A ordem "mais recente em cima" é premissa do contador; se o HUD do
  streamer inverter, a calibração por canal marca isso.
- **Calibração obrigatória por canal** (novo): crop do timer e dos slots do
  killfeed. Cada streamer tem HUD, escala e overlays próprios (no caso
  medido havia webcams na barra do topo, mas o killfeed estava limpo).

### 7.3 Contagem sem vítima

Não dá para deduplicar por vítima (§4.3). A contagem é por **borda de
slot**:

- uma kill nova = o conteúdo do slot 1 **muda de assinatura** e o killer lido
  é o streamer (distância ≤2);
- a mesma assinatura persistindo por 4–9 s **não** incrementa;
- cada kill confirmada entra com `matchedReads` (quantas leituras
  concordaram) e `confidence`;
- fim de round: **segunda passada** com o killfeed completo (a tela do painel
  de vitória ainda mostra as linhas) para validar as últimas kills.

Assinatura = texto normalizado do slot (letras, sem ícones). Duas kills
seguidas do streamer na mesma assinatura só se diferenciam pela vítima —
que é justamente o campo perdido. É por isso que o modo POV **não** é
confiável para 5K (5 linhas, várias com o mesmo killer) e é menos frágil para
4K.

### 7.4 Janela do clipe

- Âncora: `atVodSec` da kill no buffer (a timeline do recorder já tem
  segmento/offset), não wall-clock.
- Início: 1ª kill − `POV_PRE_ROLL_SEC` (default **20 s** — a reação é o
  produto, não o frag; 60 s é longo demais para o formato).
- Fim: última kill + `POV_POST_ROLL_SEC` (default **20 s**).
- Enriquecimento: `writeClipSidecar()` com `kills[]` que o OCR conseguiu e
  `anchorConfidence` marcando a origem OCR.

### 7.5 Publicação

- **Fila de revisão**, sempre: `YT_UPLOAD` privado + sidecar com
  `review: 'pov'`. Nunca automático.
- Seletor: só **4K/5K** (`score ≥ 4`), reusando a ideia do piso diário se
  ele existir; sem piso, o volume de 4K de streamer é alto demais para
  revisão manual.
- Thumb/Shorts desligados no começo: o adesivo/título assumem partida.

### 7.6 Banco

Reusa `ace_events`/`clips` com `channel_id`. Diferença: `round` vem do
contador OCR (não da HLTV), `map` precisa ser configurado no canal (OCR de
mapa é outro problema) e `kills[]` pode vir incompleto. Nada de tabela nova.

---

## 8. Guardrails (fail-closed)

| Situação | Ação |
|---|---|
| Timer sem leitura plausível por > 20 s | não corta; loga `pov-clock-lost` |
| Contagem com `confidence` baixa | não corta; entra em `discarded_events` com motivo |
| Kill do streamer sem 2ª leitura concordante | não corta (regra de "duas testemunhas") |
| Kill no **primeiro** segundo do round ou no freeze time | descarta (borda ambígua) |
| Killfeed empurrado (2+ kills em <2 s) | conta o que deu, marca `atLeast: true` |
| Canal sem calibração | canal desabilitado, como já acontece no multi-canal |

A regra de "duas testemunhas" (mesma kill lida em ≥2 segundos diferentes) é o
único jeito de subir a precisão para perto de 100% com recall de ~44%/s.
Ela não custa latência: o buffer é de 240 s.

---

## 9. Teste de aceitação (antes de qualquer código de produção)

Este é o teste que a medição **não** respondeu. Precisa de:

- **≥ 20 rounds** de **≥ 2 streamers** diferentes (HUDs/escalas diferentes);
- ground truth humano: quantas kills o streamer fez em cada round, lido do VOD;
- rodar o protótipo (timer + slots + contador por borda) só em **log**, sem
  cortar nada.

Critérios de corte:

| Métrica | Limite | Por quê |
|---|---|---|
| Recall de rounds 4K/5K | **100%** | perder a kill da capa é o pior erro |
| Precisão de "é 4K/5K de verdade" | **≥ 90%** | abaixo disso a fila de revisão vira lixo |
| Erro de contagem nos *publicados* | **0** | um 3K rotulado 4K é o que o canal não pode ter |
| Timer monotônico | **≥ 99%** | sem relógio não há reset de round |
| Falsos positivos por round | **≤ 1** | acima disso o volume de revisão não fecha |

Se precisão < 90%, a feature **não** vira modo de publicação: no máximo um
"detector de candidatos" que só avisa o operador.

---

## 10. O que mata a feature

1. **Streamers com HUD customizado/oculto** — crop do killfeed e do timer
   não são universais; cada canal vira um trabalho de calibração.
2. **Overlays na frente do killfeed** (webcam, alertas, chat) — no caso
   medido estava limpo; não é garantia.
3. **Nomes curtos** (`mTh1`, `jSt`, `R10`) — se o *streamer* tiver nome curto,
   o detector perde o killer, e aí não existe sinal nenhum.
4. **5K** — 5 linhas do mesmo killer, empilhando, é o cenário onde a
   assinatura de slot colide. Provável: 5K no POV fica fora do escopo.
5. **Custo contínuo** — 0,3–0,5 núcleo por streamer 24/7, sem ROI claro.

Nenhum desses é definitivo sozinho; juntos, eles explicam por que a
recomendação é "modo separado, fila de revisão, nunca automático".

---

## 11. Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Reusar o runtime HLTV com `--pov` | o runtime assume DOM/scorebot; o `handleAce` inteiro pressupõe ground truth |
| OCR do killfeed com o matcher atual (`NICKNAME_MAX_DISTANCE=1`) | perde `stesliega`/`stesioga` — medido: a 3ª kill do 3K não seria detectada |
| Detectar por áudio (grito/reação) | não há ground truth; e o produto é o clipe, não o grito |
| Detectar por K/D do placar | o placar do POV não é do jogador, é do time; e Premier não mostra K/D no HUD |
| Pico de kills no placar do round | o placar só muda no fim do round — tarde demais para a janela |

---

## 12. Referências

- `src/recorder/streamRecorder.ts` — `RecorderOptions.streamUrl`,
  `capturePlan()`, buffer em MPEG-TS.
- `src/clipper/killfeedSync.ts` — `NICKNAME_MAX_DISTANCE`, cadeia de crops.
- `src/clipper/clipWindowOcr.ts` — OCR do MP4 renderizado (guardrail de
  janela), não do stream.
- `src/clipper/scoreboardSync.ts` — OCR de placar com crops por canal.
- `src/detector/matchTracker.ts` — `parseRoundTimer`, fonte DOM que o POV
  não tem.
- `scripts/ocr-probe.ts` — probe usado na medição.
- `docs/janela-do-clipe.md` — histórico de falhas de OCR/crop.
- `docs/multi-canal.md` — isolamento de canal (base do modo POV).
- `docs/clipes-incrementais.md` — piso diário (complementar, não
  pré-requisito).
