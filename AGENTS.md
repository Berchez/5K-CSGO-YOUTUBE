# AGENTS.md — 5K-CSGO-YOUTUBE

Bot que monitora partidas ao vivo na HLTV, grava um buffer local da stream,
detecta multikills (4K/5K), corta o clipe, publica no YouTube (privado por
padrão) e grava o SQLite. O `index.py` é o legado de 2021 — não é o runtime.

Arquitetura e convenções de código: `.github/copilot-instructions.md`.
Operação (envs, latência, Shorts, thumbs): `README.md`.

## Comandos (rode da raiz do repo)

- Antes de terminar: `npm run lint` (`tsc --noEmit`), `npm test` (vitest) e
  `npm run build` (`tsc -p tsconfig.build.json` → `dist/`). Os três têm que
  passar.
- Um teste: `npm test -- tests/arquivo.test.ts`.
- O `lint` typechecka `src/`, `scripts/` e `tests/` — o vitest não checa tipos,
  então é ele que pega o erro de tipo no teste.
- Produção: pm2 `5k-bot` → `dist/src/main.js` (cwd fixo no
  `ecosystem.config.cjs`); depois de `npm run build`, `pm2 restart 5k-bot`.
- One-off: `npx tsx scripts/x.ts --flag` (no Windows `npm run x -- --flag` às
  vezes engole as flags).

## Killfeed do scorebot (dado, não relógio)

- O placar do DOM é o **relógio do round** (placar/round/timer). O killfeed do
  scorebot **só enriquece**: arma, headshot, assistência e a vítima.
- Campo ausente no feed fica `undefined` — **nunca** `false`.
- O placar pareia a vítima pela coluna de mortes e às vezes **erra** (outro
  jogador matou no mesmo round). O feed tem a verdade.
- Round fechado continua vivo por carência (`SCOREBOT_LATE_ENRICH_SEC`,
  default 60s) para o enrich tardio; o sidecar é escrito depois.
- Backfill de clipe já gravado: `npx tsx scripts/enrich-clip.ts --clip <pasta>`
  (dry-run; `--apply` grava). O filtro é **estrito**: kill sem round (`round: 0`)
  ou sem mapa NÃO entra.

## Sidecar (v2 em disco)

- Grave SEMPRE por `writeClipSidecar()`/`writeShortMarker()`
  (`src/clipper/sidecar.ts`): escrita atômica (`.tmp`+`rename`) nos dois.
  O **sidecar** ainda guarda o backup do v1 (`.v1.bak`) na 1ª migração;
  o **marker** do Short não tem backup (não existe v1 dele).
  **Não** use `fs.writeFileSync` direto no sidecar/marker.
- `stats` (armas/vítimas/headshots) é **derivado das `kills[]`**, não do
  `summary` do round (ele fica obsoleto quando o killfeed chega depois).
- `kills[].atVodSec` + `vod.atSec` dão a posição da kill no clipe mesmo sem
  epoch do VOD; `anchorConfidence` é o diagnóstico da âncora de início.
- O placar do round no sidecar é **CT-T** (`round.scoreOrder: 'ct-t'`), não
  team1-team2: os times trocam de lado no halftime. O `round.winner` só é
  preenchido quando a origem sabe (VOD/demo) — não derive do placar CT-T.

---

## Multi-canal (BR + EN) — fases 0/1 prontas, runtime EN ainda não

- O canal default é **sempre `br`** (`DEFAULT_CHANNEL_ID`): dados legados,
  sidecar v1 e o runtime BR são do `br`. **Não existe env para trocar o
  default** (era `DEFAULT_CHANNEL`, removido).
- `CHANNELS=br,en` registra os canais; canal **fora** da lista é erro
  (`getChannelConfig`). O canal default lê as chaves **sem prefixo**
  (`BR_*` é ignorado).
- Canal **não-default** é fail-closed: `YT_UPLOAD`/`SHORTS_ENABLED` só
  ligam com valor explícito e **válido**; `YT_TOKEN_PATH`,
  `YT_CLIENT_SECRETS`, `CLIPS_DIR`, `BUFFER_DIR`, `SHORTS_DIR`,
  `WATCHLIST_FILE`, `SHORTS_OVERLAY_CONFIG` e `CHANNEL_LANGUAGE` são
  **obrigatórios** e não podem apontar para o caminho do BR
  (`channelIsolationErrors`). Canal inválido é **desabilitado**, o BR
  segue normal.
- Banco: `channel_id` em `ace_events`/`clips`/`discarded_events`; o
  `clips.channel_id` é **derivado do ace** (`insertClip`), não vem do
  chamador. Dedup, cota e Shorts publicados são por canal.
- Sidecar/marker: `channelId` obrigatório na leitura — ausente = `br`,
  **inválido = erro** (não vira `br`).
- Migração do banco: rebuild de `ace_events` com backup automático
  (`<db>.pre-channel.bak`), `tx.immediate()`, contagem e
  `foreign_key_check`. `npm run db:migrate` = dry-run; `--apply` migra.
- **As fases 2+ não existem ainda**: canal configurado além do BR só é
  logado ("inativo"), não captura nem publica nada.
- Plano completo: `docs/multi-canal.md`.

---

## Shorts

- Adesivo (sticker) por clipe: `config/shorts-overlays.json` (chave = pasta do
  clipe). Precedência: **flag da CLI > arquivo > marker gravado > `.env`**. O
  marker guarda o spec **pedido** (`auto`, `preset: ...`), não o texto resolvido:
  `auto` resolve de novo e o visual do preset vem do código. A CLI NÃO é
  gravada (texto de teste de dry-run não vira adesivo). Marker sem adesivo
  (`render.overlayText` vazio) não manda nada.
  **O marker NÃO persiste campos de origem `.env`** (só `file`/`marker`):
  mudar o `.env` continua valendo para os clipes já renderizados
  (`overlaySpecForMarker`).
- Cota do YouTube: dia do Pacífico (`YT_QUOTA_TIMEZONE`), teto
  (`YT_QUOTA_UNITS_PER_DAY`), cálculo em `quotaDecision`/`startOfDaySql`. Elevar
  o teto só durante a publicação — **reverter depois** (é MANUAL: o código
  só lê o `.env`, não escreve nele).
- Retry do Gemini: só 5xx/`UNAVAILABLE`/"high demand" repetem; **429 de cota
  não**. `SHORTS_CAPTION_GEMINI_RETRIES` = tentativas no TOTAL (default 3).

## Regras do projeto

- **Comentários, logs e mensagens em português.** Código (funções/variáveis)
  em inglês.
- **Copy em português:** é "na Dust2" (com A), não "no Dust2" — vale para
  adesivo, título, descrição e legenda.
- **Funções puras + teste.** Regra de negócio em função pura testável; o
  efeito colateral fica no chamador. Testes são puros (sem rede, credenciais
  ou binários externos).
- ESM/NodeNext: import relativo leva `.js` (`import './env.js'`).
- Config é uma fonte só: schema Zod/defaults em `src/config.ts`; o painel
  (`src/trayConfig.ts`) e os validadores leem dela — não duplique regra.
- Playwright `page.evaluate` roda na página: o `tsx` injeta `__name` nas
  funções nomeadas e a página não tem esse helper (o `getBrowser` injeta um
  shim identidade). Arrow anônima como argumento (`.filter((e) => …)`) é
  seguro; binding nomeado dentro do callback não é.
- **Nunca commitar/pushar** sem pedido explícito. `.env`, `token.json`,
  `client_secrets.json` e perfis de login não são versionados.
- **Não mexer em `data/`, `logs/`** (artefatos de produção) sem pedido.

## A janela do clipe (leia antes de mexer no corte)

A janela (quando o clipe abre/fecha) é o defeito que mais voltou e o mais
caro: clipe publicado com janela errada **não volta**. O guardrail
pós-render roda por padrão (`CLIP_VALIDATE=on`): descartar clipe com janela
inválida é o comportamento esperado, não bug.

**Ao mexer em âncoras, latência, killfeed, placar ou replay-aware, leia
`docs/janela-do-clipe.md`** — runbook com invariantes, sintomas,
procedimento de diagnóstico e histórico. O agente `janela-clipe` existe neste
workspace, mas `.opencode/` é gitignored (não vem no clone).

Harness (use antes de opinar):

```bash
npm run diag:clip -- data/clips/<pasta>
npm run diag:clip -- --match <matchId> --ocr
npm run explain -- --match <matchId>   # política de kills + o que faltou em cada round (só log)
```

## Ambiente

- `ffmpeg`, `ffprobe` e `yt-dlp` ficam em `.tools/` (gitignored; o boot avisa
  se faltam). O código resolve o binário com `resolveFfmpegBin`/
  `resolveFfprobeBin` (`src/clipper/segmentProbe.ts`) — não chame `ffmpeg`
  pelo nome.
- Caminhos de runtime são relativos ao CWD (`./data`, `./logs`, `.tools`):
  rode tudo da raiz do repo. O `.env` é lido da raiz com `override: true`
  (`src/env.ts`): variável no shell **perde** para o `.env`.
- `logs/bot.log` é JSON por linha (pino) e fica aberto pelo bot: leia com
  `Select-String -LiteralPath` ou um script node com `JSON.parse` (não há
  `grep` no PATH do Windows).
- PowerShell: `node -e` perde aspas duplas (use here-string
  `@'...'@ | node --input-type=module -`) e `Set-Content` grava BOM (edite com
  as ferramentas de arquivo).
