# 5K CS2 → YouTube (v2 — modern rewrite)

A 100% automated bot up to human review: it monitors **live matches on HLTV** (configurable star filter, `0` = any match), detects **multikills** — 4k/5k in matches with **at least 1 star**, and only 5k in matches **without a star** — cuts from a **continuous local buffer** and uploads as **private on YouTube** for you to review/publish.

> The 2021 legacy (`index.py`, Selenium + absolute XPaths) was kept in the repo only as reference. The new code lives in `src/` (Node/TypeScript).

## How it works

```text
HLTV /matches (Playwright, 45s base; ocioso espera até 30min conforme a próxima partida) → filtro MIN_STARS (0 = tudo)
  → recorder: yt-dlp (official EN ou Gaules, via STREAM_PRIORITY) → melhor formato combinado (muxed) da fonte, ffmpeg segmentos 10s (MPEG-TS, resiliente a quedas), últimos ~240s
  → detector: live scoreboard (K/D column diff) → 4+ kills with a star / 5 kills without a star in the round = multikill (4K!/ACE!)
  → clipper: um MP4 por evento (fonte muxed, resolução nativa), com trim exato
  → uploader: YouTube Data API videos.insert (private) + SQLite dedup + log em arquivo
```

Scope (as chosen): **4k+ in starred matches / 5k in unstarred matches, horizontal only, no Shorts, no Discord, log only**. `MIN_KILLS` and `MIN_KILLS_NO_STARS` in `.env` set both thresholds. Teams/players in the **watchlist** are the exception: a listed team records even at 0–1★ with its own threshold (see below).

## Prerequisites (Windows)

```powershell
node --version  # >= 20
npm install
npx playwright install chromium
Copy-Item .env.example .env
```
The recorder uses `yt-dlp` + `ffmpeg` vendored in `.tools/` (no streamlink,
no winget) — downloaded on the first run.

Edit `.env`: `MIN_STARS=0`, `MIN_KILLS=4`, `MIN_KILLS_NO_STARS=5`, `STREAM_PRIORITY=official,en` (or `gaules` to
record the Gaules broadcast in PT-BR — with automatic cross-fallback:
if the chosen one is unavailable, the other is used), the rest keeps the
defaults.

During each match the recorder keeps a single continuous buffer, taken from
the best **combined (muxed)** format the source exposes — audio and video in
the same variant, at the source's own resolution/FPS (no artificial cap).
That means there is never a skew between separate audio/video feeds to
correct, and the clip keeps the source resolution (upscale is opt-in, see
`CLIP_UPSCALE_HEIGHT`). If the source does not offer a combined format, the
match is skipped: nothing is recorded, no clip is produced and no video is
uploaded (the reason is written to the log and the stream is marked as
failed so the next poll tries another candidate). The format selector is
configurable (`CAPTURE_FORMAT`, default `best`) — that is the kill-switch of
the capture layer; it must always point to a **combined** variant
(`bv*` would bring the A/V skew back).
Clips are saved as `<match>_<map>_r<round>_<player>.mp4` — that same file is
what goes to YouTube. The sidecar records frozen-frame intervals detected
before encoding. They are not removed/interpolated automatically: if the
source already froze, inventing motion could make the game evidence worse.

## YouTube (once)

1. Google Cloud Console → enable **YouTube Data API v3** → create an **OAuth Client (Desktop)** → download it as `client_secrets.json` in the root.
2. **OAuth consent screen → publish the app (production mode).** In "Test" mode,
   Google often refuses consent via a brand account (`Service unavailable`).
   In production with a sensitive scope (`youtube.upload`), the "unverified app" warning appears
   (click Advanced → continue) and there is a 100-account limit — enough for personal use.
3. `npm run auth:youtube` → open the URL, paste the code → generates `token.json`.
4. Uploads go out as **private**. Publish manually in YouTube Studio after reviewing (avoids a strike/audit on a new project).

### Brand channel (e.g. parent account + child channel)
The API posts to the channel **selected on the consent screen** — the token is bound to the channel.
Re-run the auth and choose the child channel (run `Remove-Item token.json` first to force
the selection screen). Check with `npx tsx scripts/check-youtube.ts`: `CANAL-NOME`
must be the clips channel. If choosing the child channel fails, publish the app
(item 2) and try again; as a last resort, transfer brand ownership to a dedicated
adult Gmail and authenticate with it.

## Running

```powershell
npm run dev     # desenvolvimento (tsx watch)
npm run build; npm start   # produção (dist/main.js)
npm test        # vitest (detector + filtro stars)
```

Keep it running: `pm2 start dist/src/main.js --name 5k-bot` + `pm2 save`.
Autostart/tray: the Startup shortcut `5K Bot.lnk` runs `scripts/bot-autostart.bat`
at logon (`pm2 resurrect` + system-tray icon via `scripts/bot-tray.ps1`).
The bot also spawns the tray on startup (single instance via mutex), so starting
it manually (`npm start`) keeps the icon too.
Useful commands: `pm2 list/logs/stop/restart 5k-bot`.

## Watchlist (teams and players)

Edit `data/watchlist.json` (or use the panel's **Watchlist** tab) to record
teams even when HLTV lists the match with 0–1★. A matched team bypasses the
star filter and uses its own kill threshold; with two matched teams, the
lowest threshold wins. A `players` entry overrides the team threshold for that
round (e.g. a 3k from a specific player), but it does not force a match outside
the star filter to be recorded. The bot reloads the file on every poll and
wakes up as soon as the file is saved — no restart; changes apply to the next
round even in a match already being tracked (and to the next matches). If the
file disappears during an editor save, the last good version is kept for up to
1 minute before falling back to the star policy.

```json
{
  "version": 1,
  "enabled": true,
  "defaults": { "minKills": 4, "clutch": false },
  "teams": [
    { "names": ["FURIA", "FURIA Esports"], "minKills": 3, "enabled": true },
    { "names": ["Legacy"], "minKills": 4, "enabled": true },
    { "names": ["Imperial", "Imperial Esports"], "minKills": 5, "enabled": true },
    { "names": ["paiN", "paiN Gaming"], "minKills": 3, "enabled": true }
  ],
  "players": []
}
```

Names are case/accent-insensitive; aliases avoid listing mismatches
(`FURIA` vs `FURIA Esports`). `minKills` is 2–5; omit it to inherit
`defaults.minKills`. Invalid JSON/values keep the last good version (the panel
shows the validation error); a UTF-8 BOM from Notepad/PowerShell is accepted.
Full example: `docs/watchlist.example.json`.
Dry-run: `npx tsx scripts/watchlist-check.ts "paiN" "FURIA" --stars=0`.

## Adaptive polling (idle backoff)

The HLTV listing already carries the scheduled start time of every upcoming
match, so the bot knows when the next match it would actually record starts.
While it is idle it does not hammer the listing every 45s: it waits half of
the remaining time (40min → 20min, 1h → 30min, capped at **30min**) and then
goes back to the base `POLL_INTERVAL_MS` inside the last 30 minutes. A match
whose scheduled time passed keeps the base interval for up to 1 hour (HLTV
delays are common), and when no eligible match is listed the bot checks again
every 15 minutes.

The backoff is a *prediction* (times change, new matches appear, the HLTV
layout breaks), so it fails open instead of closed:

- if the listing shows no upcoming match at all (or the extraction of the
  upcoming cards fails), the schedule is considered **unreliable** and the bot
  stays on the base interval — it never sleeps blind;
- the base interval is always used while a qualifying match is live, a
  recorder or tracker is running, a clip is being built, a deferred buffer
  cleanup is pending, the listing was blocked by Cloudflare, or the watchlist
  changed during the poll;
- `POLL_ADAPTIVE=false` disables the whole feature (always the base
  interval) — the kill switch.

Saving `data/watchlist.json` wakes the bot up: the next poll happens a few
seconds after the save (never sooner than one base interval after the
previous poll), so repeated file touches (autosave, OneDrive) collapse into a
single listing check. A save that the poll in flight already applied doesn't
wake anything (the backoff keeps its schedule). The panel shows the next poll
and the next eligible match.

Each live match that is detected for the first time is logged with the
detection latency (`latencyMs` = detection time − scheduled start) and
whether it was the predicted next match, so the backoff limits can be tuned
against real data.

While the bot waits in the backoff it closes the browser (RAM/CPU free); the
persistent profile keeps the Cloudflare clearance, and the next poll
relaunches it. The relaunch can blink on screen (the real Chrome sometimes
ignores the "minimized" flag), so the browser is only closed when the wait is
**long** (`HLTV_CLOSE_BROWSER_MIN_IDLE_MS`, default 10min) — a short wait
isn't worth a restart. `HLTV_CLOSE_BROWSER_IDLE=false` keeps the browser open
the whole time.

## Testing with a finished match (without waiting for live)

The real mode is LIVE, but you can validate download → clip → upload with a VOD:

```powershell
# bins portáteis (uma vez; ficam em .tools/, ignorados pelo git)
# yt-dlp + ffmpeg já baixados; se faltar: veja scripts/test-vod.ts (URLs)
npx tsx scripts/test-vod.ts --url "<VOD twitch/youtube>" --at 01:23:45 --player ZywOo
# com upload (exige client_secrets.json + npm run auth:youtube antes):
npx tsx scripts/test-vod.ts --url "<VOD>" --at 4820 --player donk --upload
```

`--at` = time of the 5th kill (accepts `HH:MM:SS` or seconds). It downloads only the window
(`--pre 60 --post 15`, `--res 1080` by default; `--res 720` to download
faster) to `data/clips/test-vod_*.mp4` + thumb + sidecar
`.json` + sqlite entry. After the download, the clip goes through
**upscale to 1440p** (`--upscale 1440` by default; `0` disables it) — uploads
>=1440p get YouTube's VP9/AV1 codec, with much higher perceived
quality even when watching at 1080p (the ~8 Mbps Twitch source remains the
ceiling). The upscale includes light restoration (denoise before the scale
so blocks are not amplified + adaptive sharpen afterwards) and the download is a stream copy
(without the CRF 23 re-encode that `--force-keyframes-at-cuts` imposed).
Live mode keeps the source resolution by default; `CLIP_UPSCALE_HEIGHT`
(0 = off, 1440/2160) applies the same upscale to the live clip, in the same
encode pass.
`.json` + sqlite entry. Everything comes out tagged `[TESTE]` — never confuse it with a real clip.
On Windows prefer `npx tsx` directly (the `npm run ... --` sometimes swallows the flags).

Rich metadata (optional, but recommended — they feed the title, description,
thumb and AI prompt): `--team1/--team2`, `--pteam` (killer's team), `--map`,
`--event`, `--round`, `--score 6-3` and `--kills` in the mini-DSL
`killer>victim:weapon:mods` (mods: `hs ns wb smoke assist=Name flash=Name`,
victim `?` = unknown):
```powershell
npx tsx scripts/test-vod.ts --url "<VOD>" --at 11:07:10 --player donk `
  --team1 Spirit --team2 Falcons --pteam Spirit --round 9 --score 6-3 `
  --kills "donk>a:ak47:hs,donk>b:ak47:flash=chopper,donk>c:ak47,donk>d:awp,donk>e:ak47"
```
The clip starts `--ctx` (default 10s) **before the 1st kill** (`--firstat`; without it,
it uses `pre` before the 5th kill and may start right on the action). In live mode the bot
anchors itself on the 1st detected kill (`CLIP_CONTEXT_SEC` in `.env`) and then shifts that
anchor by `CLIP_STREAM_LATENCY_MS`: the recorded HLS feed reaches the buffer ~25s after
the game happened, while the segment mtime marks when the file was *written*. Without the
shift the cut points at footage that has not been recorded yet and the clip opens in the
previous round. The round end uses `CLIP_SCORE_DELAY_MS` (the scoreboard publishes the
round score later than it publishes each kill).

That latency is not the same for every source, so it can be set per channel with
`CLIP_STREAM_LATENCY_BY_STREAM` (`{"Gaules": 22000, "ESL TV": 30000}`) — the global
`CLIP_STREAM_LATENCY_MS` stays as the fallback. When the scoreboard OCR finds the round
transition inside the video, the bot logs the **observed** latency of that channel
(`latência observada da stream`) next to the configured value, which is how you calibrate
it. When the round end is only *estimated* (the OCR did not find it), the cut gets an
extra tail (`CLIP_END_TAIL_SEC`): a latency that was underestimated would otherwise close
the clip before the round and drop the last kill — a short clip is worse than a long one.

The start of the clip pays the opposite error: if the real latency is *smaller* than the
configured one, the clip would begin **after** the first kill and lose it. The cut
therefore opens `CLIP_CONTEXT_SEC + CLIP_START_MARGIN_SEC` before the first kill
(`CLIP_START_MARGIN_SEC`, default 5s) — the cheap side of the error (a few extra seconds
of the previous round) instead of the expensive one (a missing first kill).

The live clip is rendered at the source resolution by default. `CLIP_UPSCALE_HEIGHT`
(0 = off, 1440/2160) re-scales it in the same encode pass (denoise + scale + sharpen):
it forces YouTube's VP9/AV1 pipeline (YouTube serves 1080p as AV1/H.264) but costs CPU,
so it is opt-in.

## Structure

```text
src/config.ts, logger.ts (arquivo), db.ts (sqlite dedup)
src/watchlist.ts (times/jogadores com limiar próprio; hot-reload de data/watchlist.json)
src/monitor/hltvMonitor.ts (stars + preferência official/en + extração live/futura do listing)
src/monitor/pollSchedule.ts (puro: quanto tempo dormir até o próximo poll)
src/monitor/pollSleep.ts (puro: deadline, wake e debounce da watchlist)
src/monitor/liveTelemetry.ts (puro: latência de detecção da live)
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

## Thumbnails: fallback chain

`THUMB_MODE=ai` enables the chain. `THUMB_AI_ORDER` sets the exact attempt
order — the first one is your preferred; any failure (quota, no login,
timeout, challenge, invalid image) logs and falls through to the next. Once the
chain is exhausted, the **deterministic composite** thumb (sharp: real frame + ACE!
badge) closes the loop — US$0, zero network, always succeeds. `THUMB_AI_TIMEOUT_MS` (default
600000 = 10min per provider) controls how long each attempt waits for the
render — web render sometimes takes over 5min.

```text
THUMB_AI_ORDER=chatgpt,grok,gemini-web
                │       │      └─ fundo híbrido (overlay sharp por cima)
                │       └─ thumb completa (layout do canal) — falha se sem login
                └─ thumb completa — falha se cota esgotada → segue a cadeia
```

| Provider | Generates | Cost | Needs |
|---|---|---|---|
| `chatgpt` | full thumb (5 refs attached) | free (daily quota) | `chatgpt-login.ts` once, throwaway account |
| `grok` | full thumb (5 refs attached) | free (X quota) | `grok-login.ts` once, throwaway X account |
| `gemini-web` | full **policy-safe** thumb (5 refs; stylized portrait with the face in shadow; the prefix "Generate an image…" is mandatory — without it the app replies with text) | free (app quota) | `gemini-login.ts` once, throwaway **Gmail** account (edu/Workspace accounts may not have image generation) |
| `huggingface` | background | free **without credits** (paid to use) | `HF_TOKEN` + credits |
| `gemini` | background | ~US$0.13/img | `GEMINI_API_KEY` + billing |
| `pollinations` | background | became paid (402) | nothing (fails fast) |
| *(end of chain)* | **composite** (sharp) | US$0 | nothing — always works |

Policy per provider: **Gemini refuses portraits of real people** — that is why,
in `gemini-web`, the layout portrait becomes a **stylized figure with the face in
shadow** (policy-safe) and the 5 references stay attached. chatgpt/grok accept
the full layout with the portrait. Team logos come from Liquipedia with a prefixed
search `"Team <Name>"` (raw search matches homonymous pages — e.g. "Spirit"
is another team — and has already downloaded the wrong logo; there is a tested
regression for this).

### Throwaway web login (chatgpt and gemini-web)
Automating the web UI violates the Terms (OpenAI and Google) — a caught account can be
suspended. **Never use important accounts.**
1. `THUMB_AI_ORDER=chatgpt` (or `gemini-web`) in `.env`.
2. `npx tsx scripts/chatgpt-login.ts` (or `gemini-login.ts`) → log in with
   a **throwaway account** → ENTER (session in `data/*-profile/`, ignored
   by git — never commit).

### gemini-web: throwaway login, never the channel account
Automating the web UI violates OpenAI/Google's Terms — a caught account can be
suspended. Therefore: **never use the account that owns the channel/Cloud project**.

## Visual references in the AI prompt (HLTV + Liquipedia)

With `--refs` (test-vod) or always in live mode, the bot downloads 5 references and
**attaches them as images** to the generation: **two photos of the player** (Liquipedia
infobox + gallery — face and uniform/pose at an event), the killer's team
logo, the opponent's logo and the map image. Sources: Liquipedia API (photos/logos/map)
with HLTV as a logo fallback. The prompt carries the MANDATORY
REFERENCES section with the specific name of each item, in the exact
order of the attachments. Everything is best-effort — each missing reference
degrades on its own (without the attachment, the prompt continues with automatic
renumbering). Team logos come from HLTV
first (browser with Cloudflare clearance, `div.profile-team-logo-container`
from the team page — always the current logo in PNG); any failure falls back to the
Liquipedia flow (infobox → Logos section → commons with scoring).

Policy per provider (validated in real tests):
- **chatgpt** (full thumb): receives the **5 references** + prompt with a
  REFERENCES section. Note: a free account has a daily image quota.
- **gemini-web** (hybrid background): receives **only the map** and a background prompt —
  Gemini **refuses** portraits of real people ("close-up portrait of player X"
  → guideline error); the face comes from the real frame via overlay.
- APIs (huggingface/gemini): background, no attachments.

Files in `data/clips/refs/` (gitignored). Manual overrides in test-vod:
`--playerphoto/--team1logo/--team2logo/--mapimg <URL>`.
1. `THUMB_AI_ORDER=gemini-web` in `.env`.
2. `npx tsx scripts/gemini-login.ts` → opens Chrome → log in with a
   **throwaway Google account** → ENTER (session saved in `data/gemini-profile/`,
   ignored by git — never commit).
3. Run `test-vod`/the bot normally; any failure (layout changed, no quota,
   no login) falls back to the composite thumb.

Web provider debug (fast, without downloading a VOD): `npx tsx scripts/gemini-probe.ts`
or `npx tsx scripts/gemini-probe.ts --order gemini-web`. The logs show each
step (open, login, submit, render, bytes); on failure, it opens
`logs/gemini-fail-*.png` to show the page state.

At our volume (a few aces/week), any paid option would come to ~US$1–2/month;
for now the composite is the production path (US$0 and validated on donk's clip).
The AI never breaks the pipeline: any failure uses the composite.

## Round data (what the AI receives)

Each ace carries a `RoundSummary`: player, teams, map, round, the 5 victims,
**weapon of each kill**, headshots, **assists and flash-assists**, damage
grenades (HE/molotov) and primary weapon. This feeds the title (`ACE! donk (AK-47)…`),
the kill-by-kill description, the thumb text and the AI background prompt.

Fidelity per source (live first, the rest later):

| Data | Live (HLTV killfeed) | GOTV demo (phase 2) |
|---|---|---|
| killer/victim | ✅ always | ✅ |
| weapon/HS | ⚠️ best-effort (icon/text in the DOM) | ✅ exact |
| assist/flash-assist | ❌ (killfeed does not show it) | ✅ exact |
| grenades thrown (smoke/flash without a kill) | ❌ | ✅ exact |

Phase 2 = download the finished match demo and parse it with a `.dem` parser
(`demofile`): completes 100% of the list (weapons, assists, HE/flash/smoke/molotov).
Missing fields come as `undefined` and the text degrades on its own.

## Titles and descriptions (AI + deterministic fallback)

Every upload gets a title and description built from the round data. The
generation runs **in parallel with the clip render**, so it costs no extra
latency on the upload.

| `YT_META_MODE` | What happens |
|---|---|
| `ai` (default) | Gemini writes 3 title options + the description; every output is checked before use. If the AI fails, times out or says something the round data doesn't support, the deterministic generator takes over. |
| `template` | Deterministic only: ~20 title formats picked by hash + rotation (never the same format twice in a row), stats, kill-by-kill, hashtags, footer. Offline, instant, no API cost. |
| `legacy` | The old fixed title/description (kill switch). |

Provider chain (`YT_META_AI_ORDER=gemini,huggingface`): the first one that
answers wins. A provider that fails twice goes on **cooldown** (10 min; 60 min
for a credential error like 401/403) and is tried again after it expires — the
breaker lives in the client, which is created once per bot session (not once
per clip), so a network blip doesn't kill the AI for the rest of the event.
The calls are queued (one at a time), so two simultaneous aces don't blow the
provider's rate limit, and the timeout is a budget shared by the retries (a bad
key fails fast, without burning the whole budget twice).

### The description

The description always has the same readable structure:

```
donk pegou o round 10 no Mirage — PGL Masters Bucharest 2026

O round 10 no Mirage virou espetáculo: donk somou 5 kills.

Round 10 | Mirage | Spirit vs MOUZ | Placar 3-6

0:10 matou Spinx
0:16 matou PR
0:19 matou sh1ro (AK-47, HS)
...

5 kills | 2 headshots | arma principal AK-47 (4/5) | duração 1:12

#cs2 #counterstrike #mirage #ace #donk #spirit #mouz #pgl

Corte automático. Vídeo não listado: aparece só para quem tem o link.
```

The opening (first two blocks) is what the AI writes — a punchy line plus a
short paragraph in 2nd person. The rest is deterministic, so the facts, the
kill-by-kill list, the stats, the hashtags and the footer are always there and
always true.

The kill timestamps point at where the elimination happens in the video: they
are measured from the **real** clip start (stored in the sidecar as
`clipStartMs`; the estimate — first kill minus the context — is only the
fallback for a clip whose opening was truncated by the buffer) and they apply
the scoreboard→video offset (`CLIP_STREAM_LATENCY_MS` − `SCOREBOARD_DELAY_MS`),
because the timestamp of a kill is the moment the HLTV scoreboard *showed* it,
while the recorded video only receives that material
`CLIP_STREAM_LATENCY_MS` later (the HLS feed the recorder consumes runs that
much behind the game). With the default context (10s) the first elimination
lands at `0:10`.

### The guard (why the AI can't publish nonsense)

The AI only receives the round's facts (JSON) and every output is validated
before it reaches YouTube. Rejected: wrong kill/headshot counts, "ace" below
5 kills, `clutch`/`1vX`, round results ("vitória/GG"), a score that isn't the
real one, naming the player's rival when the player's side is unknown, URLs,
hashtags in the title, more than one emoji, titles over 100 chars and
descriptions over 5000 bytes. A rejected title falls back to the deterministic one;
a rejected description falls back to the deterministic narrative. Either way
the video is published with something correct.

The guard only looks at what the AI wrote (title and opening). The footer and
the `YT_DESC_CTA` line are yours — a CTA with a link stays in the description
(YouTube accepts links there), and the round data itself is never "wrong".

Titles always carry the player name plus the event (or the team), at most one
emoji (`🔥💥⚡🎯💀🚨❗`), and no hashtags — those go at the end of the
description. `YT_BRAND` (e.g. `5K CS`) becomes a hashtag in the description,
`YT_DESC_CTA` adds a closing line, and the "published as private" footer only
appears when `YT_PRIVACY=private`.

Preview before publishing anything (reads the sidecars of recent clips):

```bash
npm run check:meta            # deterministic titles for the last 5 clips
npm run check:meta -- --ai    # same, through the AI chain
npm run check:meta -- --ai --n 3 --json
```

## Known limits

- HLTV has Cloudflare: selectors are by class/`data-*` with fallback, but the layout can break — see `logs/bot.log`.
- Max `MAX_RECORDINGS=2` by default so as not to overload the PC.
- No buffer = no clip (the event is saved in sqlite, you can cut it later via VOD — outside the MVP).
- The tracker only runs while a recorder is up: a match without a stream produces no event row at all. If the last recorder drops, the tracker keeps running for one more poll (to close the round) and then stops.
- Matches listed as 0★ (no rating in the listing) only yield a clip at `MIN_KILLS_NO_STARS` (default 5 = ACE); a 4★ match yields a clip from `MIN_KILLS` (default 4). The watchlist is the exception: a listed team records even at 0–1★ using its own threshold.
- An event whose kills have no footage in the buffer is discarded and recorded in `discarded_events` (sqlite) instead of being deleted silently.
- No clip queue/quota guard: a watchlist threshold of 2 on a busy match can create more clips/private uploads than the daily YouTube API quota allows.
- Rights: even an official stream can trigger Content ID. Starting private + reviewing the title/description is intentional.
