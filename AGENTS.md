# AGENTS.md — 5K-CSGO-YOUTUBE

Bot que detecta aces (4K/5K) de CS2 nas streams, corta o clipe, publica
no YouTube e grava o banco.

## Regras do projeto

- **Comentários, logs e mensagens em português.** O código (nomes de
  função/variável) em inglês, como já está.
- **Funções puras + teste.** A regra de negócio vai para uma função pura
  testável; o efeito colateral fica no chamador. `tests/` usa vitest.
- **Antes de terminar**: `npm run lint` (tsc --noEmit), `npm test`,
  `npm run build`. Os três têm que passar.
- **Nunca commitar/pushar** sem pedido explícito. `.env` não é versionado.
- **Não mexer em `data/`, `logs/`** (artefatos de produção) sem pedido.

## A janela do clipe (leia antes de mexer no corte)

A janela de corte (quando o clipe abre/fecha) é o defeito que mais
voltou e o mais caro: um clipe publicado com a janela errada **não
volta**.

**Ao mexer em âncoras, latência, killfeed, placar ou replay-aware, leia
`docs/janela-do-clipe.md` primeiro** — é o runbook com o contrato das
invariantes, os sintomas, o procedimento de diagnóstico e o histórico
honesto das soluções tentadas. Para um problema de janela, use o agente
dedicado `janela-clipe`.

Harness de medição (use antes de opinar):

```bash
npm run diag:clip -- data/clips/<pasta>
npm run diag:clip -- --match <matchId> --ocr
```

## Ambiente

- `ffmpeg` não está no PATH: use `.tools/ffmpeg.exe`
  (`resolveFfmpegBin`).
- O `grep` do shell não lê `logs/bot.log` (encoding) — use
  `Select-String -LiteralPath` ou um script node com `JSON.parse`.
- No PowerShell, `node -e` perde aspas duplas: use here-string
  `@'...'@ | node --input-type=module -`.
- Produção: pm2 `5k-bot` → `node dist/src/main.js`. Depois de
  `npm run build`, é preciso `pm2 restart 5k-bot`.
