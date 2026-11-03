# AGENTS.md — 5K-CSGO-YOUTUBE

Bot que monitora partidas ao vivo na HLTV, grava um buffer local da stream,
detecta multikills (4K/5K), corta o clipe, publica no YouTube (privado por
padrão) e grava o SQLite. O `index.py` é o legado de 2021 — não é o runtime.

Arquitetura e convenções de código: `.github/copilot-instructions.md`.
Operação (envs, latência, Shorts, thumbs): `README.md`.

## Comandos (rode da raiz do repo)

- Antes de terminar: `npm run lint` (`tsc --noEmit`), `npm test` (vitest) e
  `npm run build`. Os três têm que passar.
- Um teste: `npm test -- tests/arquivo.test.ts`.
- O `lint` typechecka `src/`, `scripts/` e `tests/` (`tsconfig.tests.json`); o
  vitest não checa tipos, então rode `npm run lint` antes de fechar a tarefa.
- Produção: pm2 `5k-bot` → `dist/src/main.js` (cwd fixo no
  `ecosystem.config.cjs`); depois de `npm run build`, `pm2 restart 5k-bot`.
- One-off: `npx tsx scripts/x.ts --flag` (no Windows `npm run x -- --flag` às
  vezes engole as flags).

## Regras do projeto

- **Comentários, logs e mensagens em português.** Código (funções/variáveis)
  em inglês.
- **Funções puras + teste.** Regra de negócio em função pura testável; o
  efeito colateral fica no chamador. Testes são puros (sem rede, credenciais
  ou binários externos).
- ESM/NodeNext: import relativo leva `.js` (`import './env.js'`).
- Config é uma fonte só: schema Zod/defaults em `src/config.ts`; o painel
  (`src/trayConfig.ts`) e os validadores leem dela — não duplique regra.
- Playwright `page.evaluate` roda na página: sem helper local nem arrow
  nomeada (o `tsx` injeta `__name`, ausente no contexto do navegador).
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
```

## Ambiente

- `ffmpeg`, `ffprobe` e `yt-dlp` ficam em `.tools/` (gitignored; o boot avisa
  se faltam). Resolva com `resolveFfmpegBin`/`resolveFfprobeBin` — não chame
  `ffmpeg` direto.
- Caminhos de runtime são relativos ao CWD (`./data`, `./logs`, `.tools`):
  rode tudo da raiz do repo. O `.env` é lido da raiz com `override: true`
  (`src/env.ts`): variável no shell **perde** para o `.env`.
- `logs/bot.log` é JSON por linha (pino) e fica aberto pelo bot: leia com
  `Select-String -LiteralPath` ou um script node com `JSON.parse` (não há
  `grep` no PATH do Windows).
- PowerShell: `node -e` perde aspas duplas (use here-string
  `@'...'@ | node --input-type=module -`) e `Set-Content` grava BOM (edite com
  as ferramentas de arquivo).
