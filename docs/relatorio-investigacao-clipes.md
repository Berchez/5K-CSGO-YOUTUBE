# Relatório de investigação — defeitos nos clipes

**Escopo original:** investigação somente leitura; nenhuma alteração foi feita durante essa fase. O estado das correções autorizadas posteriormente está na seção 8.

## 1. Resumo do pipeline atual

O código deste repositório **não gera clipes a partir de demos `.dem`**. Ele monitora partidas live no HLTV, acompanha mudanças no scoreboard e seleciona um stream para gravar. O README descreve a extração de dados de demo como uma fase futura (`README.md:3-15, 222-223`); não encontrei demos versionadas nem conversão de tick no código atual.

O tracker calcula o round a partir do placar (`src/detector/matchTracker.ts:83`), detecta mudanças na contagem de kills e cria âncoras em horário de parede (`:143-192`). O recorder resolve URLs HLS de vídeo e áudio separadamente e grava segmentos MPEG-TS (`src/recorder/streamRecorder.ts:178-247`). Ao detectar o evento, `main.ts` seleciona e copia segmentos, mede o span e passa o snapshot ao clipper (`src/main.ts:224-261`). O clipper seleciona os segmentos utilizáveis, calcula os trims e faz concatenação com reencode H.264/AAC (`src/clipper/clipBuilder.ts:916-965, 1151-1227`).

Portanto, tickrate 64/128, freeze time e conversão tick↔tempo **não são etapas deste pipeline**. O round vem do placar; a janela é estimada por timestamps do tracker e dos arquivos gravados.

## 2. Sintomas e evidências

### 2.1 Flicker, “vai e volta” e travadas

**Fatos verificados**

- Os MP4 examinados são todos H.264, 2560×1440, declarados a 60 fps, com áudio AAC. Os FPS médios ficam próximos de 60 tanto nos clipes problemáticos como nos controles; não há uma diferença clara de codec ou taxa declarada.
- Os timestamps dos pacotes de vídeo avançam normalmente, geralmente em intervalos de ~16,7 ms. Nos casos examinados, não vi lacunas longas de PTS. As durações reportadas de áudio e vídeo diferem por poucos milissegundos a dezenas de milissegundos.
- A varredura de frames com `freezedetect` (`n=-50dB:d=0.5`) encontrou:
  - `2399668_Mirage_r18_Antuanette`: **23 intervalos**, somando ~36,6 s; o maior dura ~5,3 s.
  - `2399261_Ancient_r1_Senzu`: **16 intervalos**, somando ~9 s; o maior dura ~0,7 s.
  - `2399467_Dust2_r14_kL1o`: **3 intervalos**, somando ~2,1 s.
  - Boombl4, xEternaLxx e os três controles indicados: nenhum intervalo nesse limiar.
- Nos sidecars de Antuanette, kL1o e Boombl4, `avIssues` é zero. Isso não descarta frames visualmente repetidos: esse campo mede problemas estruturais nos segmentos, não conteúdo de imagem.

**Avaliação**

Há evidência de conteúdo visual quase imóvel em parte dos clipes, especialmente Antuanette. Como os timestamps continuam avançando, isso **não parece ser explicado por grandes lacunas de PTS ou por uma saída claramente VFR**. O filtro pode sinalizar uma imagem intencionalmente estática ou uma tela de transição; sem os segmentos-fonte correspondentes, ainda não dá para determinar se a repetição já vinha do stream ou foi introduzida na gravação/concatenação.

| Hipótese | Confiança |
|---|---|
| O MP4 de Antuanette contém longos trechos de frames quase idênticos | Alta |
| Esses trechos são congelamentos oriundos do HLS/captura, e não imagens estáticas intencionais | Média |
| A causa é principalmente VFR ou grandes buracos de PTS no arquivo final | Baixa, não apoiada pelos pacotes examinados |
| A concatenação dos segmentos contribui para o defeito visual | Média-baixa; precisa comparar com os TS originais |

### 2.2 Clipe no momento errado — `2399261_Ancient_r1_Senzu`

**Fatos verificados**

- O log registra o evento como Senzu, Ancient, round 1, com quatro kills (`logs/bot.log:15402`). Não encontrei sidecar JSON desse clipe para confirmar as âncoras gravadas.
- O log da montagem informa `picked:20` na seleção e span de **199,67 s em 20 arquivos**; depois, a montagem usa **19 segmentos**. Registra `trimStartSec:26.994` e `trimEndSec:131.994` (`logs/bot.log:15413-15416, 15436`).
- O MP4 tem 132 s. Com os valores locais de pre/post roll, o teto configurado pelo código seria 60 + 15 + 30 = **105 s**.
- O código declara que `trimEndSec` é uma duração relativa ao início (`src/clipper/clipBuilder.ts:1152-1155`), mas `applyDurationCap` subtrai `trimStartSec` de `trimEndSec` e, ao limitar, soma o início novamente (`:597-607`). Para os valores do log, `131.994 - 26.994 = 105`: o teste estrito `> cap` não limita o caso, apesar de o clipe renderizado durar ~132 s.
- A detecção de retomada de ação registrou `actionStartSec:154`, mas a âncora fixa de fim foi registrada ~53,5 s depois da hora correspondente à retomada (`logs/bot.log:15422`). O modo replay-aware é **shadow**: mede e registra, mas não aplica o fim alternativo (`src/config.ts:26-35`, `src/clipper/clipBuilder.ts:1061-1087`).

**Causas prováveis**

1. **Teto de duração não aplicado corretamente** — confiança **alta** como defeito do código e explicação para a duração excessiva. A relação com o conteúdo entre rounds é provável, mas o MP4 sem sidecar não permite provar exatamente qual trecho foi acrescentado.
2. **Timeline inconsistente entre os arquivos medidos e os concatenados** — confiança **alta como defeito estrutural**, detalhado também no sintoma 4. Isso pode deslocar os trims.
3. **Âncora fixa de fim diverge da heurística de retomada** — confiança **média** como indício de corte tardio. A heurística pode detectar uma retomada que não corresponde ao início real do round.

### 2.3 Áudio adiantado em relação à imagem

**Fatos verificados**

- Os sidecars de kL1o, Boombl4, xEternaLxx e Antuanette indicam `avMode: "log"` e `avAppliedMs: 0`. As medições não encontraram uma correlação confiável: razões incluem “sem pico dominante” e, no xEternal, resultados inconsistentes entre metades (`data/clips/*.json`).
- `CLIP_AV_SYNC` não está definido no `.env` na época da investigação; o default era `log`, que media mas **não corrigia** (`src/config.ts:69-70`). A configuração local de offset era apenas `ESL TV=2000`; os logs identificam as fontes dos exemplos como CCT 2, Gaules, NODWIN e BetBoom 5, então esse override não corresponde a essas fontes. (Estado histórico: o subsistema de offset/calibração foi removido em 28/10/2026 com a captura única muxed.)
- O recorder resolve URLs HLS independentes para áudio e vídeo (`src/recorder/streamRecorder.ts:178-227`). A história confirma que a abordagem de entradas separadas está no commit `bbc4f52`.
- No MP4 final, áudio e vídeo começam perto de zero e suas durações ficam próximas. Isso não mede o alinhamento do **conteúdo**: o encode pode normalizar os timestamps mesmo que o disparo audível e o visual estejam defasados.

**Hipóteses ranqueadas**

| Hipótese | Confiança |
|---|---|
| Offset de conteúdo varia com a fonte HLS/sessão; áudio e vídeo vêm de playlists separadas | Média-alta |
| O modo atual não corrige o offset porque está em `log` e a medição falha nos exemplos | Alta para explicar por que o defeito permanece; não identifica a origem original |
| O offset muda depois de reinícios/discontinuidades do transcode | Média; o código e a calibragem por stream contemplam essa possibilidade, mas não há evidência correlacionada a esses clipes |
| Há drift crescente ao longo de cada clipe | Indeterminado. Os timestamps do container não provam nem excluem drift de conteúdo |

Os registros fornecidos mostram offsets observados em pontos isolados; não bastam para concluir se os 2–4 s são constantes durante cada clipe ou se crescem com o tempo. Não encontrei avisos de A/V associados aos intervalos desses quatro eventos; isso também não elimina um offset de conteúdo.

### 2.4 Clipe começa tarde / perde kills iniciais — `2399081_Dust2_r17_xEternaLxx`

**Evidência mais forte: span calculado para mais arquivos do que o concat usa**

- `main.ts` mede `probeConcatSpan` sobre `picked` (`src/main.ts:248`) e só depois chama `buildClip` (`:261`).
- Dentro de `buildClip`, a sequência passa por `contiguousTail` e `sanitizeSegments` (`src/clipper/clipBuilder.ts:956-963`). A sanitização remove o segmento mais novo quando há mais de dois, sob a suposição de que ainda está sendo escrito (`:465-483`).
- Para xEternal, o log mede span de **7 arquivos**, mas a montagem informa **6 segmentos** (`logs/bot.log:15059, 15062, 15068`). Antuanette tem a mesma diferença: 9 medidos e 8 usados (`:15614, 15617, 15625`). Senzu: 20 medidos e 19 usados (`:15413, 15416, 15436`).
- Mesmo assim, `buildClip` recebe o span medido antes da remoção e usa o mtime do último arquivo restante para derivar o início da timeline (`src/clipper/clipBuilder.ts:963-1000`).
- Para xEternal, `trimStartSec` foi 23,868 s; o resultado final tem 36,33 s (`logs/bot.log:15068`, `ffprobe`). O span registrado era 68,89 s; subtraído o trim, daria ~45 s — cerca de 8,7 s a mais que a duração final, próximo de um segmento.

**Causa provável**

A medição e a lista de arquivos concatenados não descrevem o mesmo conjunto. Como o span inclui um segmento que a sanitização remove, o cálculo pode colocar o início estimado da concatenação perto de um segmento (~10 s) cedo demais; o `trimStartSec` aumenta e o vídeo começa tarde em relação à âncora. É uma explicação **de alta confiança para um deslocamento na ordem de um segmento** e compatível com as primeiras kills ausentes. Ainda é preciso confirmar o deslocamento exato no conteúdo-fonte.

**Fator adicional**

A âncora de início deriva da primeira kill **observada** no diff do scoreboard, menos um atraso configurável de 10 s, e não do instante real de cada kill (`src/detector/matchTracker.ts:176-192`; default em `src/config.ts:54-57`). A confiança do tracker não é uma validação de que a primeira kill observada foi a primeira kill real do round. Isso pode somar erro variável, mas não é necessário para explicar o deslocamento de um segmento.

## 3. Síntese: causas compartilhadas e independentes

- **Início tarde e momento errado:** provavelmente compartilham o problema confirmado de medir uma timeline diferente da que é concatenada; o teto de duração também está incorreto e contribuiu diretamente para o clipe de 132 s do Senzu.
- **Desync de áudio:** provavelmente é um problema distinto de alinhamento de conteúdo entre feeds. A saída tem PTS e durações alinhados, mas o modo de correção não aplica offset nesses casos.
- **Flicker/travadas:** há trechos de frames quase idênticos em alguns MP4, sem grandes lacunas de timestamps. Pode ser problema independente do desync e do corte; falta o TS original para localizá-lo na cadeia.

A cronologia também limita a atribuição: `91d9e80` introduziu a lógica de medição, diagnóstico e teto; `git blame` atribui `applyDurationCap` a esse commit. Há alterações locais não commitadas em arquivos centrais e o processo roda código compilado em `dist`; não é possível atribuir todos os arquivos analisados ao mesmo build exato sem confirmar qual versão estava ativa quando foram gerados.

## 4. Soluções candidatas e tradeoffs

| Causa | Caminho proposto | Complexidade, risco e custo |
|---|---|---|
| Span e concat usam conjuntos diferentes | Fazer medição e render usarem exatamente a mesma lista sanitizada; manter o descarte de segmento parcial somente se sua remoção também refletir na timeline medida. | Baixa-média complexidade, sem custo de CPU significativo. Risco baixo se a proteção contra TS parcial for preservada; pode alterar início/fim de todos os clipes, inclusive os bons. |
| Teto de duração interpreta `trimEndSec` incorretamente | Corrigir a semântica da função e cobrir os casos com início não-zero, fim ancorado e fallback sem fim. | Baixa complexidade, sem custo de render. Afeta principalmente clipes acima do teto; não deve exigir mudanças nos trims normais. |
| Offset A/V por fonte ou sessão | Medir offset em pontos de áudio/visual identificáveis; calibrar por stream e sessão. Só aplicar correção com evidência suficiente e manter o default conservador. | Média-alta complexidade. Medição por conteúdo custa CPU e pode errar; um offset global pode piorar clipes bons. O arquivo atual já diferencia streams, mas cobre apenas ESL TV. |
| Frames repetidos | Primeiro comparar `freezedetect` no TS gravado e no MP4 final. Se o TS já tiver repetição, investigar feed HLS/captura; se só o MP4 tiver, investigar concat/reencode e filtros. | Diagnóstico baixo custo; correções dependem da origem. Não recomendo remover filtros ou interpolar frames sem localizar o ponto de introdução. |
| Round/tick, caso exista um produtor separado por demo | Identificar o script real e a demo. Só então conferir tickrate e eventos de round/tick contra o código desse produtor. | Escopo indeterminado. O pipeline atual não fornece esses dados; adicionar uma etapa de demo seria uma mudança arquitetural, não um ajuste do clipper live. |

## 5. Ordem de execução recomendada

1. **Corrigir a consistência da lista de segmentos e sua timeline**, junto do teto de duração. São defeitos demonstrados em log, explicam janelas truncadas/deslocadas e não dependem de hipóteses sobre tickrate ou conteúdo do stream.
2. **Validar início/fim com xEternal e Senzu**, preservando Antuanette, kL1o e os controles como referência. Não sobrescrever os originais: renderizar para uma pasta isolada.
3. **Investigar o desync por fonte/sessão** com marcadores verificáveis no início, meio e fim. Assim se distingue offset constante de drift antes de ativar qualquer correção automática.
4. **Localizar a origem dos frames repetidos** comparando TS original e MP4, começando por Antuanette e Senzu e usando um controle. Só então escolher entre ajuste de captura, concatenação ou filtro.
5. Se o processo que gera os clipes for realmente baseado em demos, **investigar esse pipeline separado**; o código atual não permite validar seus ticks ou round IDs.

## 6. Plano de validação após aprovação

- Criar testes unitários para `applyDurationCap` com `trimStartSec > 0` e verificar que a duração final nunca ultrapassa o teto.
- Adicionar um teste que garanta que a medição do span e o concat usem exatamente os mesmos arquivos após sanitização; verificar no sidecar contagem de medidos, removidos e usados.
- Fazer renders em diretório temporário separado para xEternal e Senzu; comparar duração, âncoras, kills visíveis e imagens-chave. Não usar só `r_frame_rate`: conferir timestamps dos pacotes, PTS inicial/final e pontos de corte.
- Para sync, comparar o mesmo evento audível/visual em três pontos do clipe e repetir em uma fonte configurada e outra sem calibração. Confirmar que o ajuste melhora o clipe ruim sem alterar os controles.
- Para freezes, medir os TS-fontes e MP4 com o mesmo limiar, inspecionar os intervalos marcados e comparar com os controles. Um intervalo estático não deve ser contado como falha sem confirmar que deveria haver movimento.
- Validar round e ticks somente contra uma demo de origem conhecida e um parser/pipeline que realmente esteja presente no processo de geração.

## 7. Perguntas em aberto

1. Esses MP4 são gerados pelo pipeline live deste repositório ou por outro processo que lê demos? Se for outro, qual script/comando e onde ficam as demos?
2. Qual build/processo gerou os arquivos — PM2 executando `dist/src/main.js`, `npm run dev` ou outro? O worktree atual tem alterações não commitadas nos arquivos de captura e corte.
3. Você tem os TS originais arquivados para Senzu, xEternal e Antuanette, ou VODs correspondentes? O buffer circular atual já não representa necessariamente os segmentos usados nesses cortes.
4. Para provar offset constante versus drift, pode fornecer o par de tempos “áudio do tiro”/“imagem do tiro” perto do início, meio e fim de ao menos um clipe?
5. Há sidecars ou metadados dos controles `2399410_Ancient_r16_FL1T` e `2399410_Ancient_r15_Jame`? Não os encontrei na pasta; o JSON do Senzu também está ausente.

## 8. Implementação posterior (15/10/2026)

- **Timeline e trims:** corrigidos. O span é medido nos segmentos sanitizados que o render realmente concatena; o teto agora limita a duração relativa do clipe. Testes de regressão cobrem o caso com início não-zero.
- **Captura dupla:** ativa continuamente os feeds separados e, se disponível, o melhor formato muxed da fonte sem teto de resolução/FPS. São gerados os dois MP4s; o muxed é preferido para upload e o separado fica como comparação/fallback. Se o formato muxed não existir, o pipeline segue com o separado.
- **Desync:** `CLIP_AV_SYNC` agora usa `auto` por padrão na variante separada. A correção só é aplicada quando a medição por conteúdo passa os limites de confiança e concorda entre metades; offsets incertos permanecem sem alteração. O muxed mantém as trilhas da mesma variante de origem e é preferido no upload. Isso reduz a exposição ao problema dos feeds separados, mas não comprova nem corrige offsets que já venham do feed muxed. Em uma amostra da captura ativa, a medição não encontrou pico confiável, então o auto-sync corretamente não aplicou deslocamento.
- **Frames congelados:** o render registra no sidecar os intervalos detectados por `freezedetect` antes do encode e os emite no log. Não descarta nem interpola frames automaticamente: sem os TS originais dos exemplos problemáticos, não há evidência de que o congelamento tenha sido introduzido pelo recorder/render, e interpolar poderia fabricar movimento. Assim, congelamentos que já estejam na transmissão permanecem não corrigidos.
- **Momento errado / kills iniciais:** a correção da timeline remove a causa de deslocamento de aproximadamente um segmento identificada no relatório. Os MP4s históricos não foram reprocessados; a confirmação do conteúdo dos exemplos exige novas ocorrências/TS correspondentes.
- **Demos:** conversão tick/demo continua fora do escopo deste repositório, que processa streams live.

Validação de código após as alterações: typecheck, build e suíte existente passaram. Isso valida o código e as regressões sintéticas, mas não substitui a confirmação visual/sonora em uma partida ao vivo.

## 9. Estado atual e revisão de robustez (28/10/2026)

Esta seção é nova: a seção 8 acima é o registro do que foi implementado em 15/10/2026 e não é reescrita — as mudanças de pipeline de depois entram aqui.

- **Captura única (muxed):** a captura dupla da §8 foi descontinuada. O recorder usa somente a melhor variante **combinada** da fonte (áudio e vídeo no mesmo formato, sem teto artificial de resolução/FPS): o clipe gerado é exatamente o arquivo enviado ao YouTube, em resolução nativa (o upscale virou opt-in, `CLIP_UPSCALE_HEIGHT`). Não existe mais captura separada nem variante de fallback: se a fonte não expõe formato combinado, a partida é ignorada (sem gravação, sem tracker, sem clipe) e a stream é marcada como falha para o próximo poll tentar outra candidata. O seletor de formato é configurável (`CAPTURE_FORMAT`, default `best`) — é o kill-switch da camada de captura; ele nunca pode apontar para vídeo separado (`bv*`), porque dois inputs trazem o skew A/V de volta (e o subsistema que o corrigia foi removido junto com a captura dupla).
- **Desync:** com a captura dupla removida, o subsistema de correção A/V (calibração por canal, offset estático, auto-sync por conteúdo e os scripts `av:calibrate`/`fix:av`) também saiu. Com uma única fonte combinada não existe skew entre feeds separados a corrigir. O diagnóstico de stall/salto de PTS por segmento continua no recorder e no sidecar (a vigia reanálise o buffer circular, que reescreve os mesmos nomes a cada volta).

- **Âncoras de latência:** as âncoras do clipe passaram a ser calculadas em um módulo puro (`src/clipper/clipAnchors.ts`), separando os três relógios: jogo, placar do HLTV e vídeo gravado. O fim do clipe tem dois caminhos: âncora exata (o OCR achou a virada do placar dentro do vídeo) ou estimativa (detecção − atraso do placar + latência + cauda de segurança `CLIP_END_TAIL_SEC`). A cauda existe porque o erro de latência é assimétrico: com a latência subestimada o corte fecha antes do round e perde a última kill. O INÍCIO paga o erro oposto (latência real menor que a configurada = 1ª kill fora do clipe) e por isso abre `CLIP_START_MARGIN_SEC` (default 5s) antes do contexto.
- **Latência por canal:** `CLIP_STREAM_LATENCY_BY_STREAM` permite ajustar a latência por stream (a estimativa global é o fallback). Quando o OCR acha a virada, o bot registra a latência **observada** do canal (mediana e delta contra o configurado) no log — a medição que faltava para calibrar. A medição não ajusta as âncoras sozinha: uma calibração errada quebraria todos os clipes do canal. A medição carrega o erro de `CLIP_SCORE_DELAY_MS` (o fechamento do round é estimado) — por isso o log mostra esse valor junto, e amostras fora da faixa plausível são descartadas.
- **Telemetria A/V de volta:** a série de offset de abertura (startΔ) por segmento, com mediana e drift, voltou ao recorder. Com captura única o skew vem da fonte, e a série é a evidência de que áudio e vídeo chegam alinhados. O buffer é circular (os mesmos nomes são reescritos a cada volta): a vigia reanálise o mesmo nome quando o mtime muda, senão ficaria cega depois dos primeiros 4min.
- **Disponibilidade:** o circuit breaker da IA de metadados passou a ter cooldown (o provider volta a ser tentado depois de um tempo, em vez de ficar desligado até o restart do bot; erro de credencial entra em cooldown longo já na primeira falha) e a fila de chamadas tem teto (acima dele o clipe usa o gerador determinístico). Um card live quebrado no listing não invalida mais o ciclo: o listing fica degradado, os cards bons são processados e a limpeza de recorders só é suspensa **para as partidas dos cards quebrados** (suspender tudo deixava recorders de partidas encerradas ocupando os slots de gravação). Falhas seguidas de extração geram um aviso na tela.
- **Diagnóstico:** o log distingue "a fonte não expõe formato combinado" (limitação da fonte) de "falha ao iniciar a gravação" (rede/ffmpeg/disco). Envs depreciadas, booleanos inválidos e mapa de latência malformado são avisados no startup (antes eram ignorados em silêncio). Exceção na composição dos metadados não derruba mais o upload (o clipe sobe pelo caminho legado).
- **Qualidade (opt-in):** o clipe live sai na resolução nativa da fonte; `CLIP_UPSCALE_HEIGHT` (0 = desligado) reescala na mesma passada do encode para forçar VP9/AV1 no YouTube, ao custo de CPU.
- **Pendente de validação ao vivo:** a captura única e as âncoras de latência só foram validadas de forma sintética. O critério de rollback continua sendo: se um clipe ao vivo abrir antes da 1ª kill ou perder a última kill, recalibrar `CLIP_STREAM_LATENCY_MS` (e `CLIP_START_MARGIN_SEC`/`CLIP_END_TAIL_SEC`) com o valor observado no log.

## 10. Sincronização temporal medida (29/10/2026)

O diagnóstico do log mostrou que a latência da stream **não é constante**: por canal, a
latência observada (virada do placar dentro do vídeo) variou de 10,9s a 105,5s — e o
histórico por canal mostra saltos de 60s+ dentro da mesma partida. A causa é o streamer
pausar, o buffer do OBS engasgar ou o transcode do Twitch reiniciar: a stream passa a entregar
material mais antigo, sem que nada no placar do HLTV mude. Como a latência configurada
(25s) era usada para todas as partidas, os clipes abriam ou fechavam no lugar errado.

O que foi implementado:

- **Latência medida por round, aplicada às âncoras.** A medição do OCR do placar (virada
  de round dentro do vídeo) passa a alimentar as âncoras: o início usa a latência em vigor
  na 1ª kill e o fim usa o **maior** valor da janela recente (fechar mais tarde nunca
  custa a última kill). A medição do round é feita no FIM do round, depois da 1ª kill:
  ela só pode **antecipar** a abertura (quando é menor que a amostra anterior); quando é
  maior, é ignorada, porque a subida pode ter acontecido depois do kill. O caso "regime
  trocou" (|delta| > `CLIP_STREAM_SYNC_MAX_STEP_MS`, default 20s) fica no log e dispara
  o killfeed, que mede o instante exato dentro do vídeo. A decisão é uma função pura
  (`resolveAdaptiveLatency`), com testes.
- **Estado persistido por canal** (`data/stream-latency.json`, escrita atômica): o
  primeiro round de uma partida já começa com a latência medida na partida anterior.
- **Killfeed como segunda medição.** O OCR do killfeed (killer+vítima na tela) dá o
  instante **exato** da 1ª kill dentro do vídeo — uma âncora que não depende de latência
  nenhuma. Entra como fallback quando o placar falha (`no-scoreboard`/`no-transition`) ou
  quando o round trocou de regime (`CLIP_KILLFEED_SYNC=off|fallback|always`).
- **Crop por canal.** O placar e o killfeed ficam em cantos diferentes conforme o canal:
  `CLIP_SCOREBOARD_CROP_BY_STREAM` / `CLIP_KILLFEED_CROP_BY_STREAM` fixam o crop, e o
  bot **memoriza** o crop que funcionou (e tenta fallbacks se o principal falhar) — antes,
  25 das 74 leituras de placar falharam, concentradas por canal.
- **Relógio de origem da playlist HLS (`#EXT-X-PROGRAM-DATE-TIME`).** Quando o PDT avança
  mais que a duração do segmento, o conteúdo "envelheceu" — mas o sinal é **ambíguo**
  (aumento de atraso OU conteúdo omitido) e uma pausa que mantém o PDT contínuo não gera
  salto. O recorder lê a playlist a cada 15s e registra o evento (`pdt-gap`); o bot NÃO
  move a âncora do início por inferência: o salto (a) dispara o OCR do killfeed, que mede
  o instante exato da 1ª kill no vídeo, e (b) entra como candidato conservador do fim
  estimado (fechar mais tarde nunca perde a última kill). Um salto detectado ao vivo num
  pulo real de atraso ainda não foi observado; o probe `scripts/probe-hls-pdt.ts` fica
  para essa validação. (Confirmado ao vivo: a playlist do Twitch traz PDT — segmentos de
  2s, 15 por janela, sem descontinuidades.)
- **Timer do round no placar do HLTV (probe `scripts/probe-hltv-timer.ts`).** O placar live
  expõe o relógio do jogo em `.scoreboard .timeText`: o relógio contando (`1:07`) e
  `Round over` quando o round acaba. O tracker passa a ler esse estado: o instante do
  "Round over" é o **fim real do round no relógio do jogo**, que substitui a estimativa
  (detecção do ace − `CLIP_SCORE_DELAY_MS`, erro de ~20s) na medição da latência — o
  erro cai para o intervalo de um poll (3s). Sem o timer (formato diferente do placar), a
  estimativa continua valendo; o log diz qual referência foi usada
  (`referenciaFimRound: timer-hltv | estimada`).
- **Buracos de timeline sinalizados.** Descontinuidade da fonte, salto de PTS, stall e
  salto do relógio de origem viram eventos no recorder; os que caem na janela do clipe
  marcam `timelineDiscontinuity` no sidecar (o material não contíguo é sinalizado, não
  entregue em silêncio).

Regras de segurança que valem para qualquer medição:

1. o fim **exato** do OCR tem prioridade sobre qualquer estimativa;
2. o **início** nunca é adiado por uma medição feita depois da 1ª kill (só antecipado
   quando ela é menor) e o **fim** nunca fecha antes da amostra conservadora (o erro caro
   — perder a 1ª ou a última kill — é sempre evitado);
3. medição fora da faixa plausível (0–120s) é descartada;
4. a referência do fim do round é o **timer real** do placar do HLTV quando existe; senão
   a estimativa (que carrega o erro de `CLIP_SCORE_DELAY_MS`) — o log sempre mostra qual
   das duas foi usada, para a medição nunca parecer mais exata do que é. Quando o "Round
   over" só aparece depois da espera de assentamento das stats (10s), o instante gravado
   é o do poll que viu a virada do placar, não o da leitura tardia;
5. `CLIP_STREAM_SYNC=log` é **shadow**: mede e registra, mas não altera nenhuma âncora
   (nem a adaptativa, nem a do killfeed); a aplicação só ocorre em `auto`.

Diagnóstico: `npx tsx scripts/sync-report.ts` (por canal: n de medições, min/med/máx,
maior salto, taxa de acerto do OCR, saltos do relógio de origem).

Validação de código após as alterações: typecheck e suíte completa (37 arquivos, 565
testes) passaram. A validação **ao vivo** ainda depende de uma partida gravada com o
build novo: o critério continua sendo o mesmo (clipe que abre antes da 1ª kill ou perde
a última kill ⇒ rollback da latência adaptativa via `CLIP_STREAM_SYNC_ADAPTIVE=false`).

## 11. Correções dos 4 clipes de 29/10/2026 (29/10/2026)

Casos analisados (registros em `data/clips/`): `2399949_Mirage_r13_biguzera` (23,2s, só
replay), `2399755_Dust2_r21_zorte` (17,9s, sem `.json`/`.jpg`), `2399948_Inferno_r18_saadzin`
(10,7s, 100% replay) e `2399753_Dust2_r18_iM` (180s de cap, ~70s de cauda). Causas raiz
independentes — cada correção abaixo fecha uma delas:

- **F3 — `roundEndedAt` do round certo.** A observação "Round over" era a **primeira que
  vence** desde o início da partida: quando o timer falhava num round, o valor antigo era
  reaproveitado e o clipe do iM foi ancorado no fim do round ANTERIOR (latência medida de
  238s). O tracker agora devolve `{round, atMs}` e o evento do round só aceita a observação
  **daquele round** (janela de 120s); observações de outro round são logadas e ignoradas.
- **F2a — buraco no OCR do placar vira inferência, não início do próximo round.** A
  varredura leva ~90s (frames seriais); quando o frame "antes" e o "depois" ficam a mais de
  20s, o primeiro frame legível do placar "depois" já é o **início do round seguinte** — era
  isso que adiantava o fim em +84,6s no iM. `findScoreTransition` agora marca
  `reason: 'gap-inferred'` e ancora no último frame "antes" + 3s, com o `afterAtMs` gravado
  no log/sidecar para auditoria.
- **F2b — virada implausível no vídeo é rejeitada.** Se a virada do placar encontrada no
  vídeo cai **depois** da estimativa + `CLIP_END_PLAUSIBILITY_SEC` (default 60s), ela só
  pode ser de um round posterior: o fim estimado prevalece (`ocrEndRejected` no log). O
  teste é assimétrico de propósito: uma virada **mais cedo** que a estimativa continua
  valendo (latência menor que a configurada é possível e a âncora exata tem prioridade);
  uma virada tardia demais, não — o round já teria acabado.
- **F2c — replay-aware (o fix real do iM).** O cap de 180s não era o problema: com a
  latência adaptativa (~105s), o round terminava ~90s antes do vídeo mostrar a ação, e o
  clipe incluía ~70s do round seguinte — começando pelo **replay**. A fila de render agora
  detecta a retomada de ação depois do fim fixo (`detectActionResume`) e fecha o clipe 2s
  antes dela, **só encurtando** e só quando a sobreposição passa de 5s. `REPLAY_AWARE=auto`
  (default) aplica com a folga; `shadow` só loga; `off`/`on` desligam/forçam.
- **F1 — freezer de segmentos (o OCR não pode esperar o anel).** O snapshot era tirado
  **depois** do OCR (serial, ~90s) e o anel de 240s já tinha rotacionado os segmentos do
  início do ace — o clipe abria no meio. Ao detectar o ace, os segmentos são **copiados
  imediatamente** para `CLIPS_DIR/.build/<id>-freeze` (`SegmentFreezer`, polling 1,5s,
  para no arquivo em gravação, respeita `DISK_MIN_FREE_GB`); OCR, killfeed e render leem
  dessa cópia congelada. `CLIP_FREEZE=off` volta ao caminho antigo. Sem o freezer, o
  `skipNewest` do OCR/killfeed continua valendo; com o freezer não (todos os arquivos já
  estão fechados).
- **F5 — cobertura estrita: ace sem a 1ª kill é descartado.** No saadzin, a 1ª kill
  antecedia o buffer e o clipe saía 100% replay. `evaluateAceCoverage` agora distingue três
  motivos: `no-kills` (nada no buffer), `first-kill-missing` (a 1ª kill antecede o material)
  e `first-kill-not-seen` (o killfeed varreu a janela **inteira** — `windowCovered` — e
  achou outras kills, mas não a 1ª ⇒ a régua de latência estava otimista). Em qualquer um,
  o evento é descartado no DB (não vira clipe) quando `CLIP_COVERAGE_STRICT=true` (default).
  Aborto/timeout do killfeed **não** descarta (não é evidência de ausência).
  *(Histórico — revogado no §12/K6: `first-kill-not-seen` saiu porque "OCR não leu o
  nome" destruiu 3 aces bons do 2399756; o strict agora exige posição exata ou régua
  que prove ausência.)*
- **F4 — ordem mp4 → json → jpg.** A thumb IA (até 600s) rodava **antes** do upload e o
  zorte ficou sem `.json` porque o processo caiu no meio. `buildClip` agora escreve o
  sidecar logo após o render e não gera mais thumbnail; o upload sobe só o mp4, a thumb é
  gerada depois (`makeClipThumbnail`, best-effort, falha = sem thumb) e aplicada via
  `thumbnails.set` (`applyThumbnail`), com o sidecar anotado por `patchSidecarThumbnail`.
  Um clipe sem thumbnail é aceitável; um clipe sem metadados/upload não é.
- **Latência do DutchBoyCasts.** Os clipes de 29/10 mostraram ~13s reais nesse canal (o
  configurado era 25s): `.env` ganhou `CLIP_STREAM_LATENCY_BY_STREAM={"dutchboycasts":15000}`
  (a chave é prefixo, case-insensitive). A medição adaptativa continua corrigindo ao vivo.

Novas configs: `CLIP_FREEZE` (default `auto`), `CLIP_COVERAGE_STRICT` (default `true`),
`CLIP_END_PLAUSIBILITY_SEC` (default `60`), `REPLAY_AWARE` (default `auto`). Rollbacks
independentes: `CLIP_FREEZE=off`, `CLIP_COVERAGE_STRICT=false`, `REPLAY_AWARE=off`,
`CLIP_STREAM_SYNC_ADAPTIVE=false`.

Validação de código: typecheck e suíte completa (38 arquivos, 598 testes) passaram. A
validação **ao vivo** segue pendente (os 4 casos já saíram do anel do buffer); critério:
clipe que abrir no replay, antes da 1ª kill ou perder a última kill ⇒ conferir o log
(`sync.reason`, `ocrEndRejected`, `replayAwareEnd`, `falta`) e aplicar o rollback da
camada correspondente.

## 12. Regressão dos 6 clipes do 2399756 — killfeed como âncora primária (30/10/2026)

Os 6 clipes de `2399756_Cache` (gaules, PGL Masters Bucharest 2026) saíram com os mesmos
defeitos de antes do F1–F5: `r9` com a 1ª kill 1s após a abertura, `r11`/`r14`/`r8` sem a
1ª kill (replay/round seguinte), `r4` cortando as kills 2–3, `r10` com "render vazio".
Regressão do `517401e` (latência medida por round aplicada ao INÍCIO).

**Modelo errado:** o `observedLatencyMs` do placar é **latência da stream + atraso de
publicação do placar** (~13–20s), não latência. No gaules a latência real era **45,0s**;
as amostras registradas diziam 58–63s — e o código as aplicou na âncora do INÍCIO
(`fonteLatency: "prior"`). As 5 amostras do canal eram todas `after-only`.

**Medição empírica (harness offline de OCR, ffmpeg+tesseract via pipe sobre os clipes
renderizados, sem escrever em disco):**

- o crop do killfeed funciona (leitura em 4/4 aces testáveis) — o defeito era o **matching**:
  `khaN→haN`, `KaiR0N-→KaiRON-`, `jL→IL`, `Xant3r→Yont3r`;
- `kill.at` (poll do HLTV) atrasa 5,2s / 5,3s / **16,4s** na mesma partida ⇒ o offset por
  kill varia 11s e o cluster de 2,5s divide conjuntos legítimos;
- self-kill (`ZywOo→ZywOo`, `jL→jL`) casava qualquer frame com o nome (falso positivo);
- o matcher antigo nunca casava `jL` (mínimo de 3 letras);
- com matching tolerante, a **1ª aparição** da linha da 1ª kill é a âncora exata em 4/4 aces.

**Correções (6 camadas independentes):**

- **K1 — matcher tolerante + âncora direta (`killfeedSync.ts`).** Distância de edição ≤1
  com as confusões do OCR (0↔O, 1↔l/I) — inclusive para nomes de 2 letras (evidência r5:
  `jL` lido `IL`; o falso positivo fica preso por exigir killer+vítima próximos no texto
  e, no fim, pelo teto da última kill), killer e
  vítima precisam estar próximos no texto (mesma linha) e self-kill exige o nome 2x. A
  âncora do início passou a ser a **1ª aparição da linha da 1ª kill − 1s** (medição direta,
  não depende de `kill.at` nem de latência); o offset (mediana do cluster) só alimenta os
  timestamps/estado quando há corroboração (≥2 kills no mesmo cluster) — novo motivo
  `first-kill-only` (âncora exata, offset sem corroboração). `minimumMatches` caiu de 3/3
  para 2/3. Novo campo `lastKillVideoMs` (1ª aparição da última kill lida), com TETO
  (âncora + intervalo placar entre kills + 25s) para um casamento falso no round seguinte
  não empurrar o fim. A varredura só para cedo quando TODAS as kills foram lidas — antes,
  `confident` na 2ª kill truncava o `lastKillVideoMs` (e o `windowCovered` mentia).
- **K2 — o placar nunca define o início (`streamLatency.ts`).** `resolveAdaptiveLatency` só
  usa amostras `confident` com fim vindo do **timer do HLTV** para o início (as
  `estimada` carregam o erro de `CLIP_SCORE_DELAY_MS`); `after-only`/`gap-inferred` são
  âncoras de FIM. Estado v2 (`LATENCY_STATE_VERSION=2`): as amostras v1 são descartadas
  (as do gaules estavam envenenadas) mas os **crops memorizados** são resgatados; a
  restauração só aceita `confident`. `main.ts` só **registra** amostra com transição
  confiante.
- **K3 — killfeed aciona sempre que o placar não é confiante (`main.ts`).** O gatilho era
  só `no-scoreboard`/`no-transition`: nos rounds `after-only`/`gap-inferred` (os piores) o
  killfeed nem rodava. Não roda com `CLIP_STREAM_SYNC=off` (o sync todo desligado) e, em
  `log` (shadow), o resultado é só do log — não entra em âncora nem em descarte. A janela
  de varredura ganhou folga (máx do dobro do configurado ou +30s) — o regime real (45s)
  escapava da janela do config (25s).
- **K4 — piso do fim SEMPRE presente e fim impossível rejeitado (`clipAnchors.ts`).** O
  fim nunca fica abaixo do piso (`endFloorMs` no log/sidecar), que é o máximo entre: a
  última kill **medida** pelo killfeed + cauda; a última kill **estimada**
  (`at − atraso + latência + cauda`) — vale mesmo sem killfeed (placar confiante); a
  virada **genuína** do placar (o round acaba depois da última kill); e
  `videoStart + 10s` (`MIN_CLIP_DURATION_SEC`, `endPinnedBy`). Mata o "render vazio"
  (4,1s) e o corte das últimas kills. E a virada lida **antes** do fim do round no
  relógio do jogo (`gameRoundEndedAtMs`, com tolerância de um poll do placar) é
  rejeitada: o vídeo é sempre posterior (r4/r10 tinham −11s e −10,3s de "latência").
- **K5 — replay-aware com piso (`clipBuilder.ts`).** `resolveReplayAwareEndMs` ganhou
  `minEndMs` (= `endFloorMs`): o corte nunca fecha antes do piso — sem ele o corte
  `auto` fechava no MEIO do ace quando a última transição quieto→ativo detectada era
  intra-round (r8: compra→ação do próprio round; as 3 kills saíam do clipe).
- **K6 — F5 só com evidência forte (`aceCoverage.ts`).** O descarte por "killfeed varreu e
  não viu a 1ª kill" saiu (OCR falho ≠ ausência). O strict agora descarta só com a posição
  **exata** da 1ª kill (killfeed) fora do buffer, ou com régua confiável (teto conservador
  na checagem inicial; offset medido na checagem final). Recupera os 3 aces destruídos.

**Config:** `.env` ganhou `"gaules":45000` no `CLIP_STREAM_LATENCY_BY_STREAM` (medido;
enquanto o killfeed não é a âncora padrão, é o fallback que abre no lado certo).

Rollbacks independentes: `CLIP_STREAM_SYNC_ADAPTIVE=false` (início volta ao configurado),
`CLIP_KILLFEED_SYNC=off`, `CLIP_COVERAGE_STRICT=false`, `REPLAY_AWARE=off`.

**Revisão (review externo, 31/10):** 6 correções incorporadas — a varredura do killfeed só
para cedo com TODAS as kills lidas (o `confident` na 2ª kill truncava o `lastKillVideoMs` e
o `windowCovered` mentia); piso do fim **sempre** presente (última kill estimada + virada
genuína do placar, `endFloorMs`), inclusive sem killfeed — sem ele o corte replay-aware
`auto` fechava no meio do ace (r8); `log`/`off` não deixam mais o killfeed alterar âncoras
nem descartar aces; `insertClip`/tray agora ANTES da thumbnail (crash = vídeo no ar sem
registro no banco); teto para o `lastKillVideoMs` (casamento falso no round seguinte);
freezer para logo após a cobertura e reconfere a origem pós-cópia (anel reescrito durante a
cópia = cópia mistura descartada); estado v1 resgata só os crops; amostras `estimada`
não alimentam o início; a checagem inicial usa o teto real de plausibilidade (120s); a
thumb ancora na última kill dentro do clipe. Recusados (com motivo): voltar
`REPLAY_AWARE=shadow` (o piso resolve a causa), distância 0 para nomes de 2 letras
(evidência r5 `jL` lido `IL`), max() do `gap-inferred` como âncora de fim (o piso já
protege as kills; revisar após a validação ao vivo), semáforo de OCR/freezer por partida
(arquitetura — follow-up).

**Revisão 2 (review externo, 31/10 — mesmo diff):** 10 correções incorporadas —
matcher com a CLASSE de confusão {1,i,j,l} e distância 0 para nomes de até 3
letras (uma leitura falsa virava âncora e descarte sem corroboração; o r5 `jL`
lido `IL` continua casando, `al` não); `lastKillVideoMs` só com âncora
(`confident`/`first-kill-only` e teto também na âncora derivada — sem âncora o
valor é null, senão um casamento no round seguinte virava barreira dura do
replay-aware); o piso ESTIMADO não passa do fim genuíno do OCR (a última kill é
sempre anterior ao fim do round; sem o cap o piso conservador devolvia cauda);
tolerância da virada do placar soma `CLIP_SCORE_DELAY_MS` quando o fim do round
é a ESTIMATIVA (±20s); amostra de latência só é gravada DEPOIS da sanidade do
fim (um OCR do round seguinte persistia um fim 80s tarde e atrasava o início do
próximo ace); `loadLatencyState` passou a aceitar v1 (recusava antes do
`fromJSON`, deixando o resgate de crops inalcançável); crop do KILLFEED
memorizado por canal (mapa separado do crop do placar); cópia do freezer
assíncrona com passadas não sobrepostas e contador de falhas; fallback ao anel
quando o freezer não produziu cópia nenhuma (antes desistia do clipe com o anel
íntegro); thumb de fallback limitada à duração do clipe. Recusados: piso
"estrito" separado para o replay-aware (o piso conservador é a proteção que o
r8 exigiu — a inflação só acontece sem amostra do round e o custo é cauda, não
kill perdida); soft-discard do ace (o descarte já vai para `discarded_events`
com motivo — auditoria, não perda silenciosa); cobertura inicial com o teto de
120s (é de propósito: descartar é destrutivo); `gap-inferred` como âncora de fim
(o piso já protege as kills); `UploadOptions.thumbnailPath` removido (usado pelo
`scripts/test-vod.ts`). Skipped (follow-up): freezer por partida, semáforo/worker
compartilhado de OCR, orçamento de frames, timestamps por kill no killfeed,
amostras `source:'killfeed'`, quebra do PR em lotes.

**Revisão 2 — validação com o corpus (harness, 31/10):** rodando o código real
sobre os 4 clipes, as âncoras de INÍCIO reproduziram exatamente as do
`clipStartMs` gravado (0,0s de diferença) e o matcher endurecido não perdeu
nenhum casamento (`jL`/`IL`/`ll` continuam casando). O harness expôs um defeito
que o review não viu: o piso ESTIMADO da última kill entrava **mesmo com a
última kill MEDIDA** e, como `endLatencyMs` é score→score (61,8s vs 45,2s
reais no r9), dominava o piso e forçava 20–46s de cauda (r11: piso 46s depois
da kill real) — o corte replay-aware ficava impossibilitado. Correção: o piso
estimado só vale quando o killfeed NÃO mediu a última kill, e o chamador só
passa `lastKillVideoMs` com cobertura COMPLETA (`confident` + todas as kills
lidas) — com 1 de 3 (r4) o valor seria a PRIMEIRA kill e o piso ficaria cedo.
Tradeoff conhecido e mantido: o piso da VIRADA do placar (`ocrEndMs`) continua
valendo, então o clipe pode terminar no instante em que o placar publica o
novo score (~3s depois do fim real do round no vídeo, ~24s depois da última
kill no r9) — é a proteção que o r8 exigiu (corte no meio do ace).
