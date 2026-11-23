# TROUBLESHOOTING.md — Runbook de sintomas comuns

> [!IMPORTANT]
> Para problemas com **janela do clipe** (abriu no lugar errado, fechou
> antes da última kill), consulte `docs/janela-do-clipe.md` — esse runbook
> é a referência completa do corte.

---

## 1. O bot não detectou um ace que aconteceu

**Sintomas:** Você viu o ace ao vivo mas não tem clipe.

**Diagnóstico:**
```powershell
npm run explain -- --match <matchId>
# ou sem --match para a última partida do log:
npm run explain
```

**O que verificar:**
- `stars` da partida × `MIN_KILLS` / `MIN_KILLS_NO_STARS`
- Watchlist ativa? `npm run explain` mostra o override
- O round chegou ao detector antes do round fechar?
- `MAX_RECORDINGS` atingido? (limite de gravações simultâneas)
- A partida estava numa stream sem formato muxed?
  Procure `MuxedFormatUnavailableError` no log

---

## 2. Clipe abre depois da 1ª kill / antes do round

**Este é o defeito mais crítico. Leia `docs/janela-do-clipe.md` completo.**

Diagnóstico rápido:
```powershell
npm run diag:clip -- data/clips/<pasta>
npm run diag:clip -- data/clips/<pasta> --ocr   # com OCR (lento)
```

Verificar:
- `anchorConfidence` no sidecar: `joinedMidRound`, `resetThisRound`
- `sync.startCapped`: o teto de latência disparou?
- `latency.startMs` vs `latency.configuredMs`

---

## 3. Clipe fecha antes da última kill

Procure no sidecar:
- `sync.reason`: `'gap-inferred'` = o OCR não encontrou a virada de round;
  o valor é um limite inferior (o round pode ter fechado mais tarde)
- Aumente `CLIP_END_TAIL_SEC` temporariamente para diagnóstico

---

## 4. Upload falhou / cota esgotada

```powershell
# Verifica canal autenticado:
npx tsx scripts/check-youtube.ts

# Verifica uploads do dia:
# O log registra cada upload com as units usadas
Select-String -LiteralPath logs/bot.log -Pattern "quota"
```

- Cota: `YT_QUOTA_UNITS_PER_DAY` (default 10000; cada upload = 1600 units)
- Dia começa no fuso `YT_QUOTA_TIMEZONE` (padrão: Pacífico)
- **Elevar o teto é MANUAL** — o código só lê o `.env`, não escreve nele

---

## 5. Token do YouTube expirado

```powershell
Remove-Item token.json
npm run auth:youtube
# Abre URL no browser → escolhe canal correto → cola o código
```

Se falhar com "Service unavailable": o app OAuth precisa estar em modo
Production (não Test) no Google Cloud Console.

---

## 6. Cloudflare bloqueando o HLTV

Sintomas: `fetchMatchListing` falha, sem partidas listadas.

- O browser armazena o clearance do Cloudflare no perfil (`HLTV_PROFILE`).
  O primeiro boot após longo período pode pedir resolução manual.
- `stealthBrowser.ts`: `trySolveChallenge()` tenta automaticamente;
  se falhar, o bot retenta no próximo poll.
- Se persistir: abra manualmente o Chrome com o perfil do bot e resolva o
  Cloudflare uma vez.

---

## 7. Shorts não aparecem no feed do YouTube

- O vídeo precisa ser **vertical** (9:16) **E** ter `#Shorts` na descrição.
- Confirme que o render gerou 9:16: `ffprobe data/shorts/<pasta>/<arquivo>.mp4`
- A hashtag é injetada automaticamente quando `isShorts: true` na chamada de upload.

---

## 8. Legenda do Short saindo dessincronizada

Sintomas: legenda aparece segundos antes ou depois da fala.

- Whisper.cpp com VAD ativo deslocava timestamps: o modo legenda roda
  **sem VAD** (`-ns` desabilitado no whisper).
- Verifique `SHORTS_CAPTION_TIMING`: `whisper-cpp` = tempo do whisper
  local (preciso); `off` = tempo do modelo de linguagem (pode adiantar 3s+).
- Silêncio inicial removido antes de transcrever (`silenceremove`);
  o offset é devolvido automaticamente.

---

## 9. OCR do placar não encontra a virada de round

```powershell
# Probe de OCR num clipe:
npx tsx scripts/ocr-probe.ts --clip data/clips/<pasta>
```

- Configurar crop por canal: `CLIP_SCOREBOARD_CROP_BY_STREAM`
  (ex: `{"gaules":"0.02:0.02:0.30:0.14"}`)
- Crops de fallback: `CLIP_SCOREBOARD_CROP_FALLBACKS`
- Sem OCR, o bot estima o fim via `CLIP_SCORE_DELAY_MS` + `CLIP_END_TAIL_SEC`

---

## 10. `ffmpeg` ou `yt-dlp` não encontrado

```
Error: ffmpeg not found in .tools/
```

- Os binários ficam em `.tools/` (gitignored).
- O boot avisa se faltam e os baixa automaticamente na primeira execução.
- Se falhar: veja as URLs em `scripts/test-vod.ts` e baixe manualmente.
- Nunca chame `ffmpeg` pelo nome — use `resolveFfmpegBin()`.

---

## 11. `Select-String` / leitura do log no Windows

O `logs/bot.log` é JSON por linha (pino) e fica aberto pelo bot:

```powershell
# Buscar por texto:
Select-String -LiteralPath logs/bot.log -Pattern "multikill"

# Parsear JSON (últimas 50 linhas):
Get-Content -Tail 50 logs/bot.log | ForEach-Object { $_ | ConvertFrom-Json }
```

Não use `grep` (não está no PATH do Windows por padrão).

---

## 12. Banco corrompido / migração falhou

```powershell
# Dry-run da migração:
npx tsx scripts/migrate-db.ts

# Aplica (cria backup automático <db>.pre-channel.bak):
npx tsx scripts/migrate-db.ts --apply
```

Se o banco estiver corrompido:
1. Pare o bot (`pm2 stop 5k-bot`)
2. Faça backup manual (`Copy-Item data/bot.sqlite data/bot.sqlite.bak`)
3. Remova e reinicie (perde o histórico de dedup — uploads anteriores
   não serão re-detectados, mas novos aces podem ser re-gravados)

---

## 13. Shorts re-renderizados inesperadamente

Sintomas: o script refaz o vertical mesmo com o marker existente.

- O marker guarda a `ShortRenderSignature` — se qualquer campo mudar
  (envs, caixa da cam, adesivo), o vertical é refeito.
- Atenção: `SHORTS_OVERLAY_TEXT=auto` está na assinatura. Adicionar
  `auto` ao `.env` pela primeira vez re-renderiza **todos os verticais
  não publicados**.

---

## 14. Processo ffmpeg órfão após crash

O `procRegistry.ts` rastreia filhos e mata no shutdown.
Se o bot crashar sem cleanup:

```powershell
# Lista processos ffmpeg:
Get-Process ffmpeg -ErrorAction SilentlyContinue

# Mata todos:
Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process
```

---

## 15. pm2 não inicia / cwd errado

O `ecosystem.config.cjs` define o `cwd` fixo. Se o pm2 não encontrar
os arquivos:

```powershell
pm2 delete 5k-bot
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```
