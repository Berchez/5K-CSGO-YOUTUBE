# SCRIPTS.md — Referência de scripts utilitários

Todos os scripts ficam em `scripts/`. Use `npx tsx scripts/<arquivo>.ts`
(no Windows, preferir `npx tsx` ao invés de `npm run` para evitar engolir flags).

---

## Diagnóstico e análise

| Comando | Descrição |
|---|---|
| `npx tsx scripts/diag-clip-window.ts -- data/clips/<pasta>` | Diagnóstico completo da janela do clipe (anchor, latência, OCR) |
| `npx tsx scripts/diag-clip-window.ts -- --match <matchId> --ocr` | Diagnóstico por matchId com OCR |
| `npx tsx scripts/explain.ts --match <matchId>` | Política de kills + o que faltou em cada round (só log) |
| `npx tsx scripts/explain.ts --log logs/bot.log` | Última partida do log |
| `npx tsx scripts/sync-report.ts` | Relatório de latência por canal (medições, min/med/máx, saltos) |
| `npx tsx scripts/check-live.ts` | Lista partidas ao vivo no HLTV agora |
| `npx tsx scripts/check-multikills.ts` | Verifica multikills detectados no banco |
| `npx tsx scripts/check-metadata.ts` | Verifica metadados dos clipes no banco |
| `npx tsx scripts/check-youtube.ts` | Verifica canal do YouTube autenticado |
| `npx tsx scripts/ocr-probe.ts` | Testa OCR de placar em segmentos |
| `npx tsx scripts/probe-hls-pdt.ts` | Inspeciona `#EXT-X-PROGRAM-DATE-TIME` de uma playlist HLS |
| `npx tsx scripts/probe-hltv-timer.ts` | Lê o timer do placar do HLTV ao vivo |
| `npx tsx scripts/diag-thumbs.ts` | Diagnóstico de thumbnails |
| `npx tsx scripts/diag-buffer-av.ts` | Diagnóstico A/V do buffer gravado |

---

## Clipe a partir de VOD

```powershell
# Básico:
npx tsx scripts/test-vod.ts --url "<URL>" --at 01:23:45 --player ZywOo

# Com upload (exige auth):
npx tsx scripts/test-vod.ts --url "<URL>" --at 4820 --player donk --upload

# Com metadados completos:
npx tsx scripts/test-vod.ts --url "<URL>" --at 11:07:10 --player donk `
  --team1 Spirit --team2 Falcons --pteam Spirit --round 9 --score 6-3 `
  --kills "donk>a:ak47:hs,donk>b:ak47,donk>c:awp,donk>d:ak47,donk>e:ak47"

# Múltiplos clipes de um VOD:
npx tsx scripts/clips-from-vod.ts --url "<URL>" --kills "..."

# Clipe de VOD por kill customizada:
npx tsx scripts/clip-from-vod.ts --url "<URL>" --at <sec> --player <name>
```

Flags importantes:
- `--at`: tempo da última kill (`HH:MM:SS` ou segundos)
- `--pre 60 --post 15`: janela em segundos
- `--ctx 10`: contexto antes da 1ª kill
- `--res 720|1080`: resolução do download
- `--upscale 1440`: upscale no render (0 = desliga)
- `--upload`: sobe para o YouTube após render
- Saída sempre marcada com `[TESTE]`

---

## Backfill e manutenção

| Comando | Descrição |
|---|---|
| `npx tsx scripts/enrich-clip.ts --clip data/clips/<pasta>` | Backfill do killfeed em clipe gravado (dry-run) |
| `npx tsx scripts/enrich-clip.ts --clip data/clips/<pasta> --apply` | Aplica o backfill |
| `npx tsx scripts/organize-clips.ts` | Reorganiza pasta de clipes |
| `npx tsx scripts/upload-vod-clips.ts` | Sobe clipes de VOD pendentes |
| `npx tsx scripts/migrate-db.ts` | Migração do banco (dry-run) |
| `npx tsx scripts/migrate-db.ts --apply` | Aplica migração do banco |

---

## Shorts

```powershell
# Renderiza sem publicar (dry-run):
npm run publish:shorts -- --dry-run

# Só um clipe:
npm run publish:shorts -- --dry-run --clip data/clips/<pasta>

# Sem IA de metadados:
npm run publish:shorts -- --dry-run --no-ai

# Sem legenda:
npm run publish:shorts -- --dry-run --no-captions

# Publica (precisa SHORTS_ENABLED=true no .env):
npm run publish:shorts -- --publish --clip data/clips/<pasta>

# Publica mesmo sem legenda:
npm run publish:shorts -- --publish --allow-no-captions --clip data/clips/...

# Refaz só a legenda dos que falharam:
npm run publish:shorts -- --dry-run --retry-captions

# Janela customizada:
npm run publish:shorts -- --dry-run --clip data/clips/<pasta> --force `
    --head-sec 1.5 --tail-sec 6 --min-sec 10 --max-sec 40

# Com adesivo (sticker):
npm run publish:shorts -- --dry-run --clip data/clips/<pasta> --force `
    --overlay-text auto --overlay-hold-sec 2 --overlay-fade-sec 0.5

# Adesivo com preset:
npm run publish:shorts -- --dry-run --clip data/clips/<pasta> --force `
    --overlay-text "FURIA NOS PLAYOFFS" --overlay-preset madhouse

# Republica (cria novo vídeo — apagar o antigo manualmente):
npm run publish:shorts -- --publish --republish --retranscribe `
    --clip data/clips/<pasta>
```

---

## Autenticação

| Comando | Descrição |
|---|---|
| `npm run auth:youtube` | Fluxo OAuth2 para o YouTube (gera `token.json`) |
| `npx tsx scripts/chatgpt-login.ts` | Login no ChatGPT (sessão do browser) |
| `npx tsx scripts/gemini-login.ts` | Login no Gemini (sessão do browser) |
| `npx tsx scripts/grok-login.ts` | Login no Grok (sessão do browser) |

---

## Watchlist

```powershell
# Verifica quais partidas ao vivo seriam gravadas:
npx tsx scripts/watchlist-check.ts "paiN" "FURIA" --stars=0

# Painel web (abre browser com o status do bot):
npx tsx scripts/tray-panel.ts
```

---

## Thumbnails

```powershell
# Demo da thumbnail composta:
npx tsx scripts/thumb-composite-demo.ts

# Busca logos do HLTV para os times:
# (via .tools/logos-hltv.ts, hltv-og.ts)
```

---

## Transcrição manual

```powershell
# Transcreve áudio de um clipe:
npx tsx scripts/transcribe.ts --clip data/clips/<pasta>

# Usando faster-whisper (Python):
python scripts/transcribe-faster-whisper.py <audio.wav>

# Usando vosk (Python):
python scripts/transcribe-vosk.py <audio.wav>
```

---

## Variáveis do `package.json` (atalhos)

```powershell
npm run lint        # tsc --noEmit
npm test            # vitest
npm run build       # tsc -p tsconfig.build.json
npm run dev         # tsx watch src/main.ts
npm start           # node dist/src/main.js
npm run auth:youtube
npm run db:migrate
npm run diag:clip
npm run explain
npm run publish:shorts
npm run sync-report
```
