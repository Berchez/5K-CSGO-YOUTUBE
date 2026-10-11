# 5K CS2 → YouTube (v2 — reescrita moderna)

Bot 100% automatizado até revisão humana: monitora jogos **live importantes no HLTV** (filtro por estrelas configurável), detecta **ACE (5 kills no mesmo round)**, recorta de um **buffer local contínuo** e sobe como **privado no YouTube** para você revisar/publicar.

> Legado 2021 (`index.py`, Selenium + XPaths absolutos) foi preservado no repo só como referência. O código novo está em `src/` (Node/TypeScript).

## Como funciona

```text
HLTV /matches (Playwright, 45s) → filtro MIN_STARS
  → recorder: streamlink (stream oficial EN) → ffmpeg segmentos 10s, últimos ~180s
  → detector: killfeed live → 5 kills mesmo player = ACE
  → clipper: ffmpeg -c copy (60s antes + 15s depois), 16:9
  → uploader: YouTube Data API videos.insert (private) + SQLite dedup + log em arquivo
```

Escopo MVP (conforme escolhido): **só 5k live, só horizontal, sem Shorts, sem Discord, só log**.

## Pré-requisitos (Windows)

```powershell
winget install Gyan.FFmpeg
winget install Streamlink.Streamlink
node --version  # >= 20
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

Edite `.env`: `MIN_STARS=4`, `STREAM_PRIORITY=official,en`, resto com defaults.

## YouTube (1x)

1. Google Cloud Console → habilite **YouTube Data API v3** → crie **OAuth Client (Desktop)** → baixe como `client_secrets.json` na raiz.
2. **Tela de consentimento OAuth → publique o app (modo produção).** Em modo "Teste",
   o Google costuma recusar consentimento via conta de marca (`Service unavailable`).
   Em produção com escopo sensível (`youtube.upload`) aparece o aviso de "app não verificado"
   (clique Avançado → continuar) e há limite de 100 contas — suficiente para uso próprio.
3. `npm run auth:youtube` → abra URL, cole o código → gera `token.json`.
4. Uploads saem como **private**. Publique manualmente no YouTube Studio após revisar (evita strike/auditoria de projeto novo).

### Canal de marca (ex: conta-mãe + canal filho)
A API posta no canal **escolhido na tela de consentimento** — o token amarra no canal.
Refaça o auth e escolha o canal filho (`Remove-Item token.json` antes para forçar
a tela de escolha). Confira com `npx tsx scripts/check-youtube.ts`: o `CANAL-NOME`
precisa ser o canal de cortes. Se a escolha do canal-filho falhar, publique o app
(item 2) e tente de novo; em último caso, transfira a titularidade da marca para um
Gmail adulto dedicado e autentique com ele.

## Rodar

```powershell
npm run dev     # desenvolvimento (tsx watch)
npm run build; npm start   # produção (dist/main.js)
npm test        # vitest (detector + filtro stars)
```

Manter ligado: use Task Scheduler ou `pm2` (`npm i -g pm2`, `pm2 start dist/main.js --name 5k-bot`, `pm2-startup`).

## Testar com partida acabada (sem esperar live)

O modo real é LIVE, mas dá para validar download → clipe → upload com um VOD:

```powershell
# bins portáteis (uma vez; ficam em .tools/, ignorados pelo git)
# yt-dlp + ffmpeg já baixados; se faltar: veja scripts/test-vod.ts (URLs)
npx tsx scripts/test-vod.ts --url "<VOD twitch/youtube>" --at 01:23:45 --player ZywOo
# com upload (exige client_secrets.json + npm run auth:youtube antes):
npx tsx scripts/test-vod.ts --url "<VOD>" --at 4820 --player donk --upload
```

`--at` = momento do 5º kill (aceita `HH:MM:SS` ou segundos). Baixa só a janela
(`--pre 60 --post 15`, 720p) para `data/clips/test-vod_*.mp4` + thumb + sidecar
`.json` + registro no sqlite. Tudo sai marcado `[TESTE]` — nunca confunda com clipe real.
No Windows prefira `npx tsx` direto (o `npm run ... --` às vezes engole as flags).

## Estrutura

```text
src/config.ts, logger.ts (arquivo), db.ts (sqlite dedup)
src/monitor/hltvMonitor.ts (stars + preferência official/en)
src/detector/aceDetector.ts (puro, testado) + matchTracker.ts (poll MR12: 13 pts)
src/recorder/streamRecorder.ts (buffer circular)
src/clipper/clipBuilder.ts (concat + thumb + sidecar json)
src/uploader/youtubeUploader.ts (private)
src/main.ts (supervisor asyncio-like)
scripts/auth-youtube.ts
tests/
```

## Limites conhecidos

- HLTV tem Cloudflare: seletores são por classe/`data-*` com fallback, mas layout pode quebrar — veja `logs/bot.log`.
- Máx `MAX_RECORDINGS=2` por padrão para não sobrecarregar o PC.
- Sem buffer = sem clipe (evento fica salvo no sqlite, dá para cortar via VOD depois — fora do MVP).
- Direitos: mesmo stream oficial pode gerar Content ID. Começar privado + revisar título/descrição é intencional.
