# 5K CS2 → YouTube (v2 — reescrita moderna)

Bot 100% automatizado até revisão humana: monitora jogos **live no HLTV** (filtro por estrelas configurável, `0` = qualquer partida), detecta **multikills (3k/4k/5k no mesmo round)**, recorta de um **buffer local contínuo** e sobe como **privado no YouTube** para você revisar/publicar.

> Legado 2021 (`index.py`, Selenium + XPaths absolutos) foi preservado no repo só como referência. O código novo está em `src/` (Node/TypeScript).

## Como funciona

```text
HLTV /matches (Playwright, 45s) → filtro MIN_STARS (0 = tudo)
  → recorder: yt-dlp (official EN ou Gaules, via STREAM_PRIORITY) → ffmpeg segmentos 10s (MPEG-TS, resiliente a quedas), últimos ~240s
  → detector: scoreboard live (diff colunas K/D) → 3+ kills mesmo player no round = multikill (3K!/4K!/ACE!)
  → clipper: passada única ffmpeg (filtro concat realinha A/V por segmento + trim exato de INÍCIO e FIM + upscale 1440p)
  → uploader: YouTube Data API videos.insert (private) + SQLite dedup + log em arquivo
```

Escopo (conforme escolhido): **3k+ live, só horizontal, sem Shorts, sem Discord, só log**. `MIN_KILLS` no `.env` sobe o mínimo (5 = só ace).

## Pré-requisitos (Windows)

```powershell
node --version  # >= 20
npm install
npx playwright install chromium
Copy-Item .env.example .env
```
O recorder usa `yt-dlp` + `ffmpeg` vendored em `.tools/` (sem streamlink,
sem winget) — download na primeira execução.

Edite `.env`: `MIN_STARS=4`, `STREAM_PRIORITY=official,en` (ou `gaules` para
gravar a transmissão do Gaules em PT-BR — com fallback cruzado automático:
a escolhida indisponível usa a outra), resto com defaults.

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

Manter ligado: `pm2 start dist/src/main.js --name 5k-bot` + `pm2 save`
(já ativo; a tarefa agendada `5KBot-Clips` roda `pm2 resurrect` no logon
via `scripts/bot-autostart.bat`). Comandos úteis: `pm2 list/logs/stop/restart 5k-bot`.

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
(`--pre 60 --post 15`, `--res 1080` por padrão; `--res 720` p/ baixar mais
rápido) para `data/clips/test-vod_*.mp4` + thumb + sidecar
`.json` + registro no sqlite. Depois do download, o clipe passa por
**upscale p/ 1440p** (`--upscale 1440` por padrão; `0` desliga) — uploads
>=1440p recebem o codec VP9/AV1 do YouTube, com qualidade percebida muito
maior mesmo assistindo em 1080p (a fonte Twitch ~8 Mbps continua sendo o
teto). O upscale inclui restauração leve (denoise antes do scale p/ não
ampliar blocos + sharpen adaptativo depois) e o download é stream copy
(sem o re-encode CRF 23 que o `--force-keyframes-at-cuts` impunha).
O modo live aplica o mesmo tratamento (`CLIP_UPSCALE_HEIGHT` no `.env`).
`.json` + registro no sqlite. Tudo sai marcado `[TESTE]` — nunca confunda com clipe real.
No Windows prefira `npx tsx` direto (o `npm run ... --` às vezes engole as flags).

Metadados ricos (opcionais, mas recomendados — alimentam título, descrição,
thumb e prompt IA): `--team1/--team2`, `--pteam` (time do autor), `--map`,
`--event`, `--round`, `--score 6-3` e `--kills` na mini-DSL
`killer>vítima:arma:mods` (mods: `hs ns wb smoke assist=Nome flash=Nome`,
vítima `?` = desconhecida):
```powershell
npx tsx scripts/test-vod.ts --url "<VOD>" --at 11:07:10 --player donk `
  --team1 Spirit --team2 Falcons --pteam Spirit --round 9 --score 6-3 `
  --kills "donk>a:ak47:hs,donk>b:ak47:flash=chopper,donk>c:ak47,donk>d:awp,donk>e:ak47"
```
O clipe começa `--ctx` (default 10s) **antes do 1º kill** (`--firstat`; sem ele,
usa `pre` antes do 5º kill e pode começar em cima da ação). No modo live o bot
ancora sozinho no 1º kill detectado (`CLIP_CONTEXT_SEC` no `.env`).

## Estrutura

```text
src/config.ts, logger.ts (arquivo), db.ts (sqlite dedup)
src/monitor/hltvMonitor.ts (stars + preferência official/en)
src/detector/aceDetector.ts (puro, testado) + matchTracker.ts (poll MR12: 13 pts)
src/recorder/streamRecorder.ts (buffer circular)
src/clipper/clipBuilder.ts (concat + sidecar json)
src/clipper/thumbnail.ts (thumb 1280x720: frame real + selo ACE!/jogador/confronto via sharp; aplicada no upload via thumbnails.set)
src/clipper/aiThumbnail.ts (opcional: fundo IA — huggingface grátis c/ token, gemini pago, pollinations legado; sempre com fallback p/ composta)
src/uploader/youtubeUploader.ts (private)
src/main.ts (supervisor asyncio-like)
scripts/auth-youtube.ts
tests/
```

## Thumbnails: cadeia de fallback

`THUMB_MODE=ai` ativa a cadeia. `THUMB_AI_ORDER` define a ordem exata de
tentativa — o primeiro é o seu preferido; qualquer falha (cota, sem login,
timeout, challenge, imagem inválida) loga e cai para o próximo. Esgotada a
cadeia, a thumb **composta determinística** (sharp: frame real + selo ACE!)
fechaa conta — US$0, zero rede, sempre sai. `THUMB_AI_TIMEOUT_MS` (default
600000 = 10min por provider) controla quanto tempo cada tentativa aguarda o
render — render web às vezes passa de 5min.

```text
THUMB_AI_ORDER=chatgpt,grok,gemini-web
                │       │      └─ fundo híbrido (overlay sharp por cima)
                │       └─ thumb completa (layout do canal) — falha se sem login
                └─ thumb completa — falha se cota esgotada → segue a cadeia
```

| Provider | Gera | Custo | Precisa |
|---|---|---|---|
| `chatgpt` | thumb completa (5 refs anexadas) | grátis (cota diária) | `chatgpt-login.ts` 1x, conta descartável |
| `grok` | thumb completa (5 refs anexadas) | grátis (cota X) | `grok-login.ts` 1x, conta X descartável |
| `gemini-web` | thumb completa **policy-safe** (5 refs; retrato estilizado com rosto na sombra; prefixo "Generate an image…" obrigatório — sem ele o app responde em texto) | grátis (cota do app) | `gemini-login.ts` 1x, conta descartável **Gmail** (contas edu/Workspace podem não ter geração de imagem) |
| `huggingface` | fundo | free **sem créditos** (pago p/ usar) | `HF_TOKEN` + créditos |
| `gemini` | fundo | ~US$0,13/img | `GEMINI_API_KEY` + billing |
| `pollinations` | fundo | virou pago (402) | nada (falha rápido) |
| *(fim da cadeia)* | **composta** (sharp) | US$0 | nada — sempre funciona |

Política por provider: o **Gemini recusa retrato de pessoa real** — por isso,
no `gemini-web`, o retrato do layout vira **figura estilizada com o rosto na
sombra** (policy-safe) e as 5 referências seguem anexadas. chatgpt/grok aceitam
o layout completo com retrato. Logos de times vêm da Liquipedia com busca
prefixada `"Team <Nome>"` (busca crua casa com páginas homônimas — ex. "Spirit"
é outro time — e já baixou logo errado; há regressão testada para isso).

### Login web descartável (chatgpt e gemini-web)
Automatizar UI web viola os Termos (OpenAI e Google) — conta pega pode ser
suspensa. **Nunca use contas importantes.**
1. `THUMB_AI_ORDER=chatgpt` (ou `gemini-web`) no `.env`.
2. `npx tsx scripts/chatgpt-login.ts` (ou `gemini-login.ts`) → faça login com
   uma **conta descartável** → ENTER (sessão em `data/*-profile/`, ignorada
   pelo git — nunca commite).

### gemini-web: login descartável, nunca a conta do canal
Automatizar a UI web viola os Termos da OpenAI/Google — conta pega pode ser
suspensa. Por isso: **nunca use a conta dona do canal/projeto Cloud**.

## Referências visuais no prompt IA (HLTV + Liquipedia)

Com `--refs` (test-vod) ou sempre no modo live, o bot baixa 5 referências e
**anexa como imagens** na geração: **duas fotos do player** (infobox + galeria
da Liquipedia — rosto e uniforme/pose em evento), logo do time do autor,
logo do adversário e imagem do mapa. Fontes: Liquipedia API (fotos/logos/mapa)
com HLTV como fallback de logo. O prompt carrega a seção REFERÊNCIAS
OBRIGATÓRIAS com o nome específico de cada item, na ordem exata dos anexos.
Tudo é best-effort — cada referência ausente degrada sozinha (sem anexo, o
prompt segue com renumeração automática). Logos dos times vêm da HLTV
primeiro (browser com clearance do Cloudflare, `div.profile-team-logo-container`
da página do time — sempre a logo vigente em PNG); qualquer falha cai no
fluxo Liquipedia (infobox → seção Logos → commons com scoring).

Política por provider (validada em testes reais):
- **chatgpt** (thumb completa): recebe as **5 referências** + prompt com
  seção REFERÊNCIAS. Nota: conta free tem cota diária de imagens.
- **gemini-web** (fundo híbrido): recebe **só o mapa** e prompt de fundo —
  o Gemini **recusa** retrato de pessoa real ("retrato em close do jogador X"
  → erro de diretrizes); rosto vem do frame real via overlay.
- APIs (huggingface/gemini): fundo, sem anexos.

Arquivos em `data/clips/refs/` (gitignored). Overrides manuais no test-vod:
`--playerphoto/--team1logo/--team2logo/--mapimg <URL>`.
1. `THUMB_AI_ORDER=gemini-web` no `.env`.
2. `npx tsx scripts/gemini-login.ts` → abre o Chrome → faça login com uma
   **conta Google descartável** → ENTER (sessão salva em `data/gemini-profile/`,
   ignorada pelo git — nunca commite).
3. Rode o `test-vod`/bot normalmente; qualquer falha (layout mudou, sem cota,
   sem login) cai para a thumb composta.

Debug do provider web (rápido, sem baixar VOD): `npx tsx scripts/gemini-probe.ts`
ou `npx tsx scripts/gemini-probe.ts --order gemini-web`. Os logs mostram cada
etapa (abertura, login, envio, render, bytes); em falha, abre
`logs/gemini-fail-*.png` para ver o estado da página.

No nosso volume (poucos aces/semana), qualquer opção paga sairia ~US$1–2/mês;
por enquanto a composta é o caminho de produção (US$0 e validada no clipe do donk).
A IA nunca quebra o pipeline: qualquer falha usa a composta.

## Dados do round (o que a IA recebe)

Cada ace carrega `RoundSummary`: jogador, times, mapa, round, as 5 vítimas,
**arma de cada kill**, headshots, **assists e flash-assists**, granadas de dano
(HE/molotov) e arma principal. Isso alimenta título (`ACE! donk (AK-47)…`),
descrição kill-a-kill, texto da thumb e o prompt do fundo IA.

Fidelidade por fonte (live primeiro, resto depois):

| Dado | Live (killfeed HLTV) | Demo GOTV (fase 2) |
|---|---|---|
| killer/vítima | ✅ sempre | ✅ |
| arma/HS | ⚠️ best-effort (ícone/texto no DOM) | ✅ exato |
| assist/flash-assist | ❌ (killfeed não mostra) | ✅ exato |
| granadas lançadas (smoke/flash sem kill) | ❌ | ✅ exato |

Fase 2 = baixar a demo da partida acabada e extrair com parser `.dem`
(`demofile`): fecha 100% da lista (armas, assists, HE/flash/smoke/molotov).
Campos ausentes vêm como `undefined` e o texto degrada sozinho.

## Limites conhecidos

- HLTV tem Cloudflare: seletores são por classe/`data-*` com fallback, mas layout pode quebrar — veja `logs/bot.log`.
- Máx `MAX_RECORDINGS=2` por padrão para não sobrecarregar o PC.
- Sem buffer = sem clipe (evento fica salvo no sqlite, dá para cortar via VOD depois — fora do MVP).
- Direitos: mesmo stream oficial pode gerar Content ID. Começar privado + revisar título/descrição é intencional.
