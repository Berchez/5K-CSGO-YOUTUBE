# BUGS.md — Inventário de Bugs, Riscos e Melhorias

Este documento mapeia os problemas confirmados, edge cases perigosos, inconsistências de tipo/build e oportunidades de melhoria identificados na auditoria do código-fonte do **5K-CSGO-YOUTUBE**.

---

## 1. Bugs Corrigidos nesta Revisão

### 1.1. [CORRIGIDO] Erros de Tipo e Falhas de Execução em `shorts.ts`
- **Arquivo:** `src/clipper/shorts.ts`, `scripts/publish-shorts.ts` e `tests/shorts.test.ts`
- **Problemas Resolvidos:**
  1. **Crash no Layout "blur" (`TypeError: Cannot read properties of null (reading 'w')`):** Corrigido em `buildShortLayout` adicionando suporte explícito a `opts.top === 'blur'` antes da checagem de `camBox`.
  2. **Export Ausente `blurGameBandTop`:** Implementada e exportada a função em `src/clipper/shorts.ts`.
  3. **Incompatibilidade de Tipo `ShortTopMode`:** Adicionado `'blur'` ao union type `ShortTopMode`.
  4. **Divergência na Janela do Short (`planShortWindow`):** Implementado `MAX_HOOK_HEAD_SEC = 6` no recuo (`back`), garantindo que o gancho inicial fique próximo da 1ª kill e sem dead air.

### 1.2. [CORRIGIDO] Backup Pré-Migração do Banco Desatualizado (`db.ts`)
- **Arquivo:** `src/db.ts` (`backupBeforeMigration`)
- **Problema Resolvido:** Se o arquivo `.pre-channel.bak` já existisse de uma migração anterior, o banco não gerava um novo backup do estado atual. Agora gera um backup com timestamp (`.pre-channel.<timestamp>.bak`) de forma consistente com o script `migrate-db.ts`.

### 1.3. [CORRIGIDO] Erro de `channelId` em Silêncio no Sidecar/Marker (`sidecar.ts`)
- **Arquivo:** `src/clipper/sidecar.ts` (`readClipSidecar`, `readShortMarker`)
- **Problema Resolvido:** Em vez de capturar qualquer exceção e retornar `null` em silêncio, o erro de parsing/validação agora é registrado como `warn` no logger, facilitando diagnósticos.

### 1.4. [CORRIGIDO] Falso Positivo e Pastas Aninhadas em Isolamento de Canal (`config.ts`)
- **Arquivo:** `src/config.ts` (`channelIsolationErrors`)
- **Problema Resolvido:** `CHANNEL_LANGUAGE` não é mais forçado a ser diferente do canal `br` (permitindo múltiplos canais em português). Além disso, `sameValue` agora detecta caminhos aninhados (ex: `./data/clips/en` dentro de `./data/clips`).

### 1.5. [CORRIGIDO] `WATCHLIST_FILE` Hardcoded em Scripts
- **Arquivo:** `scripts/check-live.ts` e `scripts/watchlist-check.ts`
- **Problema Resolvido:** Passaram a consultar `getConfig().WATCHLIST_FILE` dinamicamente em vez de assumir caminho fixo.

### 1.6. [CORRIGIDO] Estabilidade de Testes Playwright / Vitest
- **Arquivo:** `vitest.config.ts`
- **Problema Resolvido:** Configurados `testTimeout: 20000` e `hookTimeout: 30000` para evitar timeouts espúrios no Windows.

---

## 2. Severidade Alta / Riscos Críticos

### 2.1. Fila de Render em Memória (`clipBuilder.ts`)
- **Arquivo:** `src/clipper/clipBuilder.ts` (linhas ~102-107)
- **Problema:** A fila de renderização é mantida através de uma variável em memória:
  ```ts
  let renderQueue: Promise<unknown> = Promise.resolve();
  function enqueueRender<T>(job: () => Promise<T>): Promise<T> {
    const run = renderQueue.then(job, job);
    renderQueue = run.catch(() => undefined);
    return run;
  }
  ```
  Se o processo sofrer um restart via PM2 ou crash enquanto um render do ffmpeg estiver rodando, a fila é perdida. Além disso, se dois multikills ocorrerem em partidas diferentes simultaneamente, o segundo clipe espera o encode do primeiro terminar (que pode levar minutos com upscale 1440p). Se o buffer circular da segunda partida continuar rodando e sobrescrever segmentos antes do `SegmentFreezer` ter capturado o snapshot, o clipe é corrompido ou descartado.
- **Impacto:** Perda de clipe se a captura de segmentos (snapshot) não ocorrer imediatamente antes do enfileiramento.
- **Recomendação:** Garantir que o `SegmentFreezer` congele os arquivos `.ts` de forma síncrona/imediata no evento da detecção antes de repassar o job à `renderQueue`.

---

### 2.2. Limpeza Total de Assistências por Teto Rígido (`scorebotFeed.ts`)
- **Arquivo:** `src/detector/scorebotFeed.ts` (linha ~184-185)
- **Problema:**
  ```ts
  if (this.assists.size > 500) this.assists.clear();
  ```
  O mapa `assists` armazena as mensagens de assistência que chegam antes das kills nos frames do scorebot. Ao atingir 501 entradas, o mapa é completamente zerado via `.clear()`, em vez de remover as entradas mais antigas (FIFO ou LRU).
- **Impacto:** Se o teto for atingido exatamente durante uma rodada com kills pendentes, as assistências dos próximos segundos perdem o pareamento e as estatísticas do sidecar ficam sem `assistBy`.
- **Recomendação:** Implementar evicção parcial (ex: remover as 100 chaves mais antigas) ou mapear por round/mapa e limpar apenas os rounds anteriores.

---

### 2.3. Precisão de `mtime` de Segmentos no Windows (`SegmentFreezer.ts` / `clipBuilder.ts`)
- **Arquivo:** `src/clipper/segmentFreezer.ts` e `src/main.ts` (linhas ~350-356)
- **Problema:** O pipeline de âncoras depende estritamente do `mtime` dos arquivos de segmento no sistema de arquivos para correlacionar o relógio do vídeo com o relógio do jogo (`fs.utimesSync(dest, st.atime, st.mtime)`). No Windows (NTFS), atualizações de `utimes` podem ter granulação diferente dependendo de flags de cache de disco e do Node.js, ocasionando variações de até centenas de milissegundos.
- **Impacto:** Variações milimétricas na âncora de início calculada via `mtime` versus o instante real em que o pacote de vídeo chegou.
- **Recomendação:** Sempre que possível, dar preferência a medições internas de PTS de vídeo (`probeConcatSpan`, `probeSegmentPackets`) e OCR do placar, usando `mtime` estritamente como aproximação macro.

---

## 3. Severidade Média / Inconsistências de Runtime

### 3.1. Halftime e Troca de Lados no Scoreboard (`matchTracker.ts`)
- **Arquivo:** `src/detector/matchTracker.ts` (linhas ~214-220 e `resolvePlayerTeam`)
- **Problema:** Na transição de lados (round 12 para 13 no CS2, ou prorrogações), o HLTV inverte as tabelas CT/T. Se o Playwright ler o DOM no exato frame em que o placar atualizou o score geral (disparando a virada do round), mas a tabela de jogadores ainda não foi repovoada com os novos lados, o `resolvePlayerTeam` pode atribuir o time antigo ao jogador ou cair em `undefined`.
- **Impacto:** Em partidas monitoradas exclusivamente via Watchlist, a queda de time para `undefined` faz o sistema considerar o jogador como não pertencente à watchlist, bloqueando o clipe (`blocked`).
- **Recomendação:** Manter cache histórico de `player -> team` durante a partida inteira (`indexPlayerTeams`), usando o time já associado ao jogador caso a leitura pontual falhe ou venha vazia.

---

### 3.2. Exaustão de Cota na Thumbnail pós-Upload (`youtubeUploader.ts`)
- **Arquivo:** `src/uploader/youtubeUploader.ts` (linhas ~110-123)
- **Problema:** A função `applyThumbnail` roda após `uploadClip`. O upload consome 1600 units da cota do YouTube. Se o saldo de cota do dia estiver entre 1600 e 1649 units, o upload do vídeo terá sucesso, mas a chamada `thumbnails.set` (custo: 50 units) lançará erro de cota 403 `quotaExceeded`.
- **Impacto:** O vídeo fica publicado como privado, porém sem thumbnail personalizada (permanece com o frame automático do YouTube). O erro é capturado e registrado como warning, sem retry automático posterior quando a cota resetar.
- **Recomendação:** Registrar no SQLite (`clips.thumbnail_pending = 1`) para permitir um script de retry de thumbnail nos clipes do dia seguinte.

---

### 3.3. Alucinação de Transcrição em Silêncios com Ruído (`shortCaptionsAi.ts`)
- **Arquivo:** `src/clipper/shortCaptionsAi.ts`
- **Problema:** Em transmissões oficiais com som de jogo e ruído ambiente de arena (sem narração ou com narração muito baixa), modelos de transcrição como Gemini ou Whisper podem alucinar frases prontas ("Obrigado por assistir", "Legendas pela comunidade...") no silêncio da fala.
- **Impacto:** O Short é renderizado com legenda espúria queimada no vídeo, prejudicando a qualidade do conteúdo.
- **Recomendação:** Reforçar a regra de descarte de frases clássicas de despedida e validar a duração do texto gerado contra o volume RMS/energia de áudio do segmento.

---

## 4. Melhorias e Débitos Técnicos

### 4.1. Estado Multi-Canal Parcial (Fases 2+)
- **Arquivo:** `src/channels.ts`, `src/main.ts`
- **Situação:** As bases de multi-canal (banco de dados com `channel_id`, isolamento de credenciais e pastas) estão prontas, mas o loop de captura em `src/main.ts` ainda é projetado como single-stream ativo (foco no canal `br`).
- **Sugestão:** Implementar o fan-out da Fase 2 (conforme planejado em `docs/multi-canal.md`), permitindo instanciar `StreamRecorder` e `matchTracker` separados por canal quando múltiplos canais estiverem configurados.

### 4.2. Churn de Abas em Branco no Playwright
- **Arquivo:** `src/monitor/hltvMonitor.ts` (`sweepStaleBlankPages`)
- **Situação:** O mecanismo de limpeza fecha abas `about:blank` após 2 minutos. Durante picos de polling ou quedas transitórias de rede, várias abas podem ser abertas antes de comitar a navegação.
- **Sugestão:** Reutilizar abas abertas em um pool controlado em vez de instanciar `newPage()` a cada checagem, diminuindo o uso de memória do Chromium em processos rodando 24/7.

### 4.3. Persistência de Transcrições de Shorts
- **Arquivo:** `src/clipper/shorts.ts`, `src/clipper/sidecar.ts`
- **Situação:** Ao re-renderizar um Short por alteração visual (como mudança no layout da webcam ou preset do adesivo), a transcrição de áudio só é reaproveitada se o marker existir e a flag `--retranscribe` não for passada.
- **Sugestão:** Salvar a transcrição bruta em arquivo dedicado (ex: `<clip>_transcript.json`) para que alterações puramente visuais no render vertical nunca consumam chamadas ou tempo de IA.
