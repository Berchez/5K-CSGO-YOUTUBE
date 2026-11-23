# ARCHITECTURE.md — 5K-CSGO-YOUTUBE

Mapa de módulos, fluxo de dados e decisões de arquitetura do bot.

> [!NOTE]
> Para regras de contribuição e comandos, veja `AGENTS.md`.
> Para operação e configuração, veja `README.md`.

---

## Visão geral do fluxo

```
HLTV /matches (Playwright)
  → filtro MIN_STARS / watchlist / rank
  → selectStream (yt-dlp resolve URL)
  → StreamRecorder: ffmpeg MPEG-TS circular buffer (~240s)
  → matchTracker: placar K/D diff → RoundTracker
      ├── scorebotFeed: killfeed (arma/headshot/assist)
      └── aceDetector: detectMultiKill → multikill detectado
  → handleAce: clipAnchors → SegmentFreezer → scoreboardSync (OCR)
      ├── killfeedSync (OCR opcional)
      └── clipBuilder: ffmpeg render → thumbnail → upload YouTube
  → SQLite dedup + sidecar JSON + tray status
```

---

## Mapa de módulos `src/`

### Núcleo

| Arquivo | Responsabilidade |
|---|---|
| `main.ts` | Supervisor: loop de poll, orquestra recorders/trackers/clipes |
| `config.ts` | Schema Zod de todas as envs; `getConfig()` cacheado; fonte única de config |
| `channels.ts` | Identidade multi-canal: `DEFAULT_CHANNEL_ID='br'`, `channelIdOrDefault` |
| `db.ts` | SQLite (`better-sqlite3`): DDL, migrações, `insertAce`/`insertClip`/`hasAce` |
| `types.ts` | Interfaces compartilhadas: `KillEvent`, `AceEvent`, `LiveMatch`, `StreamInfo` |
| `paths.ts` | Resolve caminhos de runtime relativos ao CWD |
| `env.ts` | Carrega `.env` com `override: true` (env do shell perde para o `.env`) |
| `watchlist.ts` | Lógica de watchlist: `resolveRoundPolicy`, `matchTeamAlias`, hot-reload |
| `trayStatus.ts` | Estado do ícone da bandeja do sistema |
| `procRegistry.ts` | Rastreia processos filho (ffmpeg): mata órfãos no shutdown |
| `diskSpace.ts` | Verificação de espaço livre antes de gravar |
| `logger.ts` | Wrapper pino: JSON por linha em `logs/bot.log` |
| `notify.ts` | Notificações do Windows (toast) |
| `timeZone.ts` | Fuso para o cálculo de cota do YouTube (`YT_QUOTA_TIMEZONE`) |

### Monitor (`src/monitor/`)

| Arquivo | Responsabilidade |
|---|---|
| `hltvMonitor.ts` | Playwright: lista partidas ao vivo, seleciona stream, lê placar/timer |
| `streamLatency.ts` | Latência adaptativa: amostras, `resolveAdaptiveLatency`, schema v3 |
| `latencyStore.ts` | Lê/grava `data/stream-latency.json` (atômico) |
| `teamRanking.ts` | Rank HLTV: `buildTeamRanking`, cache, `rankMatchDecision` |
| `pollSchedule.ts` | Decide o intervalo do próximo poll (backoff adaptativo) |
| `pollSleep.ts` | Aguarda o próximo poll com wakeup por watchlist |
| `liveTelemetry.ts` | Eventos de detecção para o painel |

### Detector (`src/detector/`)

| Arquivo | Responsabilidade |
|---|---|
| `aceDetector.ts` | Puro: `detectMultiKill`, `RoundTracker`, `killLabel`, `prettyWeapon` |
| `matchTracker.ts` | Lê o placar via Playwright em loop; alimenta `RoundTracker` |
| `scorebotFeed.ts` | Cliente Engine.IO do scorebot do HLTV (via `fetch` da página) |
| `scorebotLog.ts` | Parser dos logs do scorebot: `parseScorebotLog`, `ScorebotKill` |
| `killfeedEnrich.ts` | Aplica o killfeed do scorebot no sidecar (backfill) |
| `killParse.ts` | Helpers de parsing de kill |
| `aceCoverage.ts` | Calcula cobertura de kills no clipe (diagnóstico) |

### Recorder (`src/recorder/`)

| Arquivo | Responsabilidade |
|---|---|
| `streamRecorder.ts` | ffmpeg + yt-dlp: buffer circular MPEG-TS, timeline events, PDT |
| `hlsTimeline.ts` | Parse de playlist HLS, `#EXT-X-PROGRAM-DATE-TIME`, saltos de PDT |

### Clipper (`src/clipper/`)

| Arquivo | Responsabilidade |
|---|---|
| `clipBuilder.ts` | Orquestra o render: `buildClip`, fila serial (1 encode por vez) |
| `clipAnchors.ts` | Puro: converte relógio do jogo → relógio do vídeo |
| `clipWindowAudit.ts` | Puro: valida a janela do clipe (`auditClipWindow`) |
| `clipWindowOcr.ts` | OCR do clipe renderizado (guardrail pós-render) |
| `scoreboardSync.ts` | OCR do placar no vídeo: detecta virada de round |
| `killfeedSync.ts` | OCR do killfeed no vídeo: `scanKillfeedForLatency` |
| `segmentProbe.ts` | `resolveFfmpegBin`/`resolveFfprobeBin`, probe de segmentos |
| `segmentFreezer.ts` | Snapshot dos segmentos (preserva o buffer para o render) |
| `sidecar.ts` | Schema v2, `writeClipSidecar`/`writeShortMarker` (atômico) |
| `shorts.ts` | Render vertical 9:16: cam + jogo, `ShortRenderSignature` |
| `shortCaptions.ts` | Legenda queimada no MP4 (libass) |
| `shortCaptionsAi.ts` | Transcrição via IA (Gemini, whisper.cpp, HuggingFace) |
| `shortOverlay.ts` | SVG do adesivo (sticker): presets, posição, fade |
| `shortOverlayConfig.ts` | Puro: precedência do adesivo (CLI > arquivo > marker > `.env`) |
| `thumbnail.ts` | Composição determinística Sharp + `makeSmartThumbnail` |
| `compositeThumbnail.ts` | Monta a thumbnail com logos dos times e player |
| `aiThumbnail.ts` | Provedores opcionais de thumb por IA (Gemini, ChatGPT, Grok…) |
| `hltvLogo.ts` | Fetcha e cacheou logos dos times do HLTV |
| `thumbCutout.ts` | Recorte de player (bg removal) para a thumbnail |
| `thumbDiag.ts` | Diagnóstico da thumbnail |
| `thumbText.ts` | Texto sobreposto na thumbnail |
| `referenceImages.ts` | Cache de imagens de referência (logos, player crops) |
| `copyRules.ts` | Regras PT-BR de copy: "na Dust2", preposições de mapa |
| `providerStatus.ts` | Estado de login dos provedores de IA |
| `stealthBrowser.ts` | Playwright stealth: contorna Cloudflare |
| `geminiWeb.ts` | Gemini via browser (login web, sem API key) |
| `chatgpt.ts` | ChatGPT via browser |
| `grok.ts` | Grok via browser |
| `imageFingerprint.ts` | Hash de imagem para dedup visual |
| `shortBanner.ts` | Banner de texto no Short |
| `attachFiles.ts` | Anexa arquivos ao prompt de IA |

### Uploader (`src/uploader/`)

| Arquivo | Responsabilidade |
|---|---|
| `youtubeUploader.ts` | OAuth2 + `videos.insert` (privado por padrão) |
| `videoMetadata.ts` | Template de título/descrição/tags; `buildVideoMetadataSafe` |
| `metadataAi.ts` | Enriquece metadados com IA (Gemini) |
| `quota.ts` | Puro: `quotaDecision` — decide se a cota do dia permite o upload |

### Transcrição (`src/transcription/`)

| Arquivo | Responsabilidade |
|---|---|
| `transcribe.ts` | Orquestrador: tenta provedores na ordem configurada |
| `registry.ts` | `PROVIDER_IDS`: lista de provedores conhecidos |
| `audio.ts` | Extrai áudio do clipe (ffmpeg) para a transcrição |
| `segments.ts` | Divide o áudio em segmentos |
| `export.ts` | Converte timestamps de transcrição para o formato da legenda |
| `limits.ts` | Limites de duração/tamanho por provedor |
| `http.ts` | HTTP helper compartilhado pelos provedores |
| `types.ts` | Tipos: `TranscriptionResult`, `TranscriptionSegment` |
| `providers/` | Implementações: Gemini, whisper.cpp, HuggingFace, OpenAI, Deepgram… |

### Diagnóstico (`src/diag/`)

| Arquivo | Responsabilidade |
|---|---|
| `explainLog.ts` | Lê o log e explica a política de kills por round |

---

## Decisões de design importantes

### Config: fonte única (`src/config.ts`)
Todas as envs são parseadas e validadas via Zod em `config.ts`. O painel
(`trayConfig.ts`) e qualquer validador leem de lá — nunca duplique uma
regra de validação.

### Escrita atômica (sidecar/marker)
`writeClipSidecar()`/`writeShortMarker()` escrevem em `.tmp` e renomeiam.
Isso garante que uma leitura nunca vê um JSON parcialmente escrito. **Não**
use `fs.writeFileSync` diretamente.

### Fila serial de render
`clipBuilder.ts` serializa encodes: no máximo 1 ffmpeg por vez. Um x264
consome quase toda a CPU; dois simultâneos travam a máquina.

### Latência adaptativa
A latência da stream **não é constante** (10s a 105s no histórico). O bot
mede por round via OCR do placar e persiste em `data/stream-latency.json`
(schema v3). Mudança de lógica de latência → leia `docs/janela-do-clipe.md`.

### Três relógios
- **Relógio do jogo**: instante real do kill (inferido do placar HLTV)
- **Relógio do vídeo**: mtime dos segmentos MPEG-TS
- **Relógio do bot**: `Date.now()`

A conversão entre eles é o núcleo de `src/clipper/clipAnchors.ts`. Errar
aqui = janela errada = clipe publicado incorreto (não tem volta).

### Fail-open vs fail-closed
- **Latência sem medição**: fail-open (abre o clipe mais cedo — perder a 1ª
  kill é pior que ter segundos extras)
- **Canal não-default**: fail-closed (`YT_UPLOAD`/`SHORTS_ENABLED` só ligam
  com valor explícito)
- **Formato muxed indisponível**: `MuxedFormatUnavailableError` — ignora a
  partida, não falha o bot

### Multi-canal (fases 0/1)
O banco tem `channel_id` em `ace_events`/`clips`/`discarded_events`. O canal
default (`br`) lê as envs sem prefixo; canais adicionais usam o prefixo
(`EN_YT_TOKEN_PATH`, etc.). Fases 2+ (captura EN) ainda não existem.

---

## Estrutura de diretórios

```
5K-CSGO-YOUTUBE/
├── src/                    # Runtime TypeScript
│   ├── main.ts             # Supervisor (ponto de entrada)
│   ├── config.ts           # Schema Zod de envs (fonte única)
│   ├── channels.ts         # Identidade multi-canal
│   ├── db.ts               # SQLite
│   ├── types.ts            # Tipos compartilhados
│   ├── monitor/            # HLTV polling, latência, ranking
│   ├── detector/           # Detecção de multikills
│   ├── recorder/           # Gravação da stream (ffmpeg + yt-dlp)
│   ├── clipper/            # Render, thumbnail, Shorts, sidecar
│   ├── uploader/           # YouTube upload, cota, metadados
│   ├── transcription/      # Legendas (Gemini, whisper.cpp, HF...)
│   └── diag/               # Diagnóstico e explain
├── scripts/                # Utilitários one-off (tsx)
├── tests/                  # Vitest (puro, sem rede)
├── docs/                   # Runbooks e planos
│   ├── janela-do-clipe.md  # Runbook do corte (LEIA antes de mexer)
│   ├── multi-canal.md      # Plano multi-canal
│   └── ...
├── config/                 # Configurações em JSON (overlays, etc.)
├── data/                   # Runtime: clipes, shorts, banco (gitignored)
├── logs/                   # Runtime: bot.log (gitignored)
├── .tools/                 # Binários vendored: ffmpeg, ffprobe, yt-dlp
├── dist/                   # Build compilado (gitignored)
├── AGENTS.md               # Guia para agentes de IA
├── ARCHITECTURE.md         # Este arquivo
├── BUGS.md                 # Bugs e melhorias conhecidos
├── SCRIPTS.md              # Referência de scripts
├── README.md               # Operação e configuração
└── .github/copilot-instructions.md  # Arquitetura e convenções
```

---

## Variáveis de ambiente críticas

> Referência completa: `src/config.ts` e `README.md`. Aqui estão as mais
> perigosas de errar.

| Variável | Default | Impacto se errado |
|---|---|---|
| `CLIP_STREAM_LATENCY_MS` | `25000` | Janela errada — clipe abre depois da 1ª kill |
| `CLIP_STREAM_SYNC` | `auto` | `log` = shadow (mede, não aplica); `off` = latência fixa |
| `CLIP_START_LATENCY_MAX_MS` | `25000` | Teto quando não há medição; `0` desliga |
| `CLIP_VALIDATE` | `on` | `off` = publica clipes com janela errada |
| `YT_UPLOAD` | `true` | `false` = desliga upload (apenas gera clipes locais) |
| `SHORTS_ENABLED` | `false` | Publicação de Shorts |
| `MIN_KILLS` | `4` | Mínimo de kills para clipe em partida ≥1★ |
| `MIN_KILLS_NO_STARS` | `5` | Mínimo de kills em partidas 0★ |
| `CHANNELS` | `br` | Canais ativos; fora da lista = erro |
| `MAX_RECORDINGS` | `2` | Máximo de partidas gravadas em paralelo |

---

## Banco de dados (SQLite)

Schema em `src/db.ts`. Três tabelas:

```sql
ace_events  (id, channel_id, match_id, map, round, player, team1, team2, event, detected_at)
            UNIQUE(channel_id, match_id, map, round, player)

clips       (id, ace_id → ace_events.id, channel_id, file_path, youtube_video_id, privacy, created_at)

discarded_events (id, channel_id, match_id, map, round, player, reason, detected_at, discarded_at)
```

- `channel_id` derivado do ace em `insertClip` — não vem do chamador.
- Dedup via `UNIQUE`: `hasAce()` antes de processar; `discardAce()` para
  registrar o descarte sem clipe.
- Migração: `npm run db:migrate` (dry-run) / `--apply` (aplica).
