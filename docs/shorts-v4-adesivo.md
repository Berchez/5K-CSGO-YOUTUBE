# Shorts v4 — legenda maior, cam menor e adesivo configurável com presets

> Plano de implementação autossuficiente. Um chat novo, sem contexto, deve
> conseguir executar só com este documento + o repositório. Leia antes o
> `AGENTS.md` (regras de comentário/teste/commit e os comandos de lint/test/build).

## 1. Objetivo

1. **Legenda** do Short maior: `SHORTS_CAPTION_FONT_SIZE` **54 → 64** (padrão global).
2. **Cam do streamer** um pouco menor: `SHORTS_CAM_HEIGHT` **660 → 600** (padrão global).
3. **Adesivo** (sticker do começo do Short) redesenhado no estilo dos clipes de
   referência, **configurável + presets**, tanto no painel quanto por CLI.
4. O Short já publicado (`2IIlT1udjEQ`, YEKINDAR) **não** é refeito; o estilo novo
   vale para os próximos. `pm2 restart` só com OK do dono.

## 2. Contexto do projeto (não pular)

- Bot de clipes de CS2: grava a live, detecta 4K/5K, corta, publica no YouTube e
  grava no SQLite. O runtime é TypeScript (`src/`); `index.py` é legado.
- Repo: `C:\06_Codigo\GitHub\5K-CSGO-YOUTUBE` (Windows, PowerShell 5.1, Node 24,
  ESM/NodeNext, Vitest, sharp, ffmpeg/ffprobe/yt-dlp em `.tools/`).
- Comentários/logs/mensagens em **português**; código (funções/variáveis) em inglês.
- Regra de negócio em **função pura + teste**. Testes não usam rede/credenciais.
- Import relativo leva `.js` (`import './env.js'`).
- Config é fonte única em `src/config.ts` (schema Zod + defaults). O painel
  (`src/trayConfig.ts`) e os validadores leem dele — **não duplique regra**.
- `.env` é lido com `override: true` (`src/env.ts`): variável no shell **perde**
  para o `.env`. Não edite `.env`; use flags de CLI para one-off.
- Nunca commitar/pushar sem pedido. Não mexer em `data/`/`logs/` sem pedido.
- Comandos da raiz: `npm run lint` (tsc), `npm test` (vitest), `npm run build`.
  Os três precisam passar antes de terminar.
- `SHORTS_ENABLED` está **ausente** no `.env` (default `false`). Para publicar
  manualmente seria preciso `SHORTS_ENABLED=true` só no processo; isso **não**
  faz parte desta tarefa (nada será publicado).

## 3. Estado atual (antes de mexer)

- Legenda: `SHORTS_CAPTION_FONT_SIZE=54` (default) → `.ass` com
  `Style: Caption,Barlow Condensed,54,...`; a legenda é queimada via libass
  (`assets/fonts/BarlowCondensed-Bold.ttf`, `fontsdir`).
- Cam: `SHORTS_CAM_HEIGHT=660`; layout em `src/clipper/shorts.ts`
  (`buildShortLayout`, faixa do topo + jogo embaixo).
  Legenda `below-crosshair` = `camHeight + (height-camHeight)/2 + 60`
  (`captionCrosshairTopY` em `src/clipper/shortCaptions.ts`), ou seja 660 → 1350;
  com 600 → 1320.
- Adesivo atual: `src/clipper/shortOverlay.ts` (pílula com gradiente, borda fina,
  sombra desfocada, sobe/balança/some). Campos: `text`, `background`, `color`,
  `holdSec`, `fadeSec`, `y`.
- Wiring: `scripts/publish-shorts.ts` monta `overlayButton` (linhas ~904-918),
  passa para `shortRenderSignature` (~919-939) e para `renderShortClip`
  (~1052 e ~1080). `src/clipper/shorts.ts` rasteriza o PNG com sharp
  (`renderShortOverlayButtonPng`), compõe com `shortOverlayFilter` e limpa o PNG
  temporário no `finally`.
- Painel: `src/trayConfig.ts` → `EDITABLE_FIELDS` (grupo `clips`) é servido por
  `scripts/tray-panel.ts` (`/api/config`) e renderizado por
  `scripts/tray-panel.html` (`renderField`/`renderSettings`). Hoje **não há**
  nenhum campo `SHORTS_OVERLAY_*` no painel.
- O Short do YEKINDAR foi publicado (`data/shorts/2399996_Cache_r23_YEKINDAR/
  _short.json` tem `youtubeId`), e `publish-shorts.ts` **pula clipe já publicado**
  (antes do `--force`). Não use esse clipe para dry-run visual.

## 4. Referências visuais (capturas já existentes)

Pasta: `C:\Users\walte\Videos\Captures\Screenshot_1..8.png` (na ordem dos links
citados pelo dono). Análise:

| # | Canal | Adesivo |
|---|-------|---------|
| 1 | PolexTV | cápsula vermelha, **borda branca die-cut**, **sombra amarela sólida** deslocada, texto branco 2 linhas |
| 2 | PolexTV | cápsula vermelha lisa, **sombra vermelho-escura sólida**, sem borda, 1 linha |
| 3 | PolexTV | idem 2 |
| 4 | Gaules | cápsula azul, borda azul-clara, **sombra azul-escura**, 2 linhas |
| 5 | MADHOUSE | retângulo amarelo, **borda roxa grossa**, texto preto, tag "MADHOUSE" no topo |
| 6 | Donos da Bala | vermelho com **borda branca irregular** (recorte orgânico), texto branco + emoji |
| 7 | MADHOUSE | idem 5, 3 linhas, tag preta "MAD HOUSE" |
| 8 | Cortes do Rei | cápsula roxa, **sombra roxa escura**, texto branco, 2 linhas |

Padrão comum: **cor chapada** (sem gradiente/brilho), **sombra sólida deslocada**
(sem blur), texto **caixa alta pesado**, cápsula/retângulo arredondado, centrado
na divisa cam/jogo; às vezes **tag da marca** e emoji. O pill atual (gradiente +
sombra desfocada) é o que destoa.

## 5. Decisões aprovadas pelo dono

- Presets **múltiplos e selecionáveis** (não escolher só um). Padrão: `polex`.
- Legenda 64 e cam 600 valem como **padrão global** (Shorts futuros).
- `2IIlT1udjEQ` fica como está; estilo novo só nos próximos.

## 6. Especificação

### 6.1 Presets

Tabela canônica (implementar em `src/clipper/shortOverlay.ts`):

| preset | shape | fundo | texto | borda | sombra (offset) | blur da sombra | tilt | fonte | caixa alta | tag |
|---|---|---|---|---|---|---|---|---|---|---|
| `polex` (default) | capsule | `#e10600` | `#ffffff` | — | `#7a0000` 10px | 0 | 0° | `Impact` | sim | — |
| `polex-die` | capsule | `#e10600` | `#ffffff` | `#ffffff` 7px | `#ffd400` 10px | 0 | 0° | `Impact` | sim | — |
| `gaules` | capsule | `#2563eb` | `#ffffff` | `#93c5fd` 4px | `#1e3a8a` 10px | 0 | 0° | `Arial Black` | sim | — |
| `madhouse` | rect (raio 14) | `#ffd400` | `#111111` | `#6b21a8` 8px | `#3b0764` 8px | 0 | −1.5° | `Arial Black` | sim | `MADHOUSE` (fundo `#6b21a8`, texto `#ffd400`) |
| `rei` | capsule | `#6d28d9` | `#ffffff` | — | `#3b0764` 10px | 0 | 0° | `Impact` | sim | — |
| `diecut` | rect (raio 18) | `#e10600` | `#ffffff` | `#ffffff` 8px | `#000000` 8px | 4 | −2° | `Impact` | sim | — |
| `pill` | capsule (visual antigo) | `#e10600` | `#ffffff` | `#ffffff` 2px (opacidade 0.22) | `#000000` 6px | 5 | 0° | `Arial Black` | sim | — |
| `custom` | base neutra (`BASE`), mas todos os campos explícitos vencem | | | | | | | | | |

- `pill` mantém o **gradiente** atual; os demais são **cor chapada**.
- `diecut` usa **borda irregular** (`feTurbulence` + `feDisplacementMap`); se o
  librsvg do sharp não renderizar, cair para borda lisa (documentar).
- Tag: pequeno retângulo arredondado no topo-centro, sobrepondo a borda superior,
  fonte ~0.42× a do texto, caixa alta.
- Emoji continua fora (o sharp/librsvg não tem fonte colorida; `stripUnsupportedGlyphs`
  remove) — não implementar emoji nesta rodada.

### 6.2 Semântica de resolução (pura, testável)

Precedência: **CLI > campo do `.env` (não vazio) > preset > base**.

- `SHORTS_OVERLAY_PRESET=custom` → começa da base neutra (`BASE`: cápsula, cor
  chapada, sombra sólida, `Arial Black`, caixa alta) e aplica só os campos.
- Campos de override vazios (`''`/`null`) = "usa o preset".
- `0` é override válido (ex.: sem borda, tilt 0).
- Texto vazio → **sem adesivo** (`null`), independentemente do preset.

Função sugerida (em `src/clipper/shortOverlay.ts`):

```ts
export type ShortOverlayPreset =
  | 'custom' | 'polex' | 'polex-die' | 'gaules'
  | 'madhouse' | 'rei' | 'diecut' | 'pill';

export interface ShortOverlayOverrides {
  shape?: 'capsule' | 'rect' | null;
  background?: string | null;
  color?: string | null;
  borderColor?: string | null;
  borderPx?: number | null;
  shadowColor?: string | null;
  shadowPx?: number | null;
  shadowBlurPx?: number | null;
  tiltDeg?: number | null;
  font?: string | null;
  uppercase?: boolean | null;
  tag?: string | null;
}

export function resolveShortOverlayStyle(input: {
  preset: ShortOverlayPreset;
  text: string;
  holdSec: number;
  fadeSec: number;
  y: number;
  overrides?: ShortOverlayOverrides;
}): ShortOverlayButton | null;
```

`ShortOverlayButton` (resolvido) passa a ter: `preset`, `text`, `shape`,
`background`, `color`, `borderColor`, `borderPx`, `shadowColor`, `shadowPx`,
`shadowBlurPx`, `tiltDeg`, `font`, `uppercase`, `tag`, `tagBackground`,
`tagColor`, `gradient`, `roughEdge`, `holdSec`, `fadeSec`, `y`.
Manter os campos antigos (`text/background/color/holdSec/fadeSec/y`) para não
quebrar chamadas existentes.

### 6.3 Config (`src/config.ts`)

Bloco atual em ~linhas 588-605. Alterar/adicionar:

| chave | tipo/default | observação |
|---|---|---|
| `SHORTS_CAPTION_FONT_SIZE` | `64` (era 54) | |
| `SHORTS_CAM_HEIGHT` | `600` (era 660) | |
| `SHORTS_OVERLAY_PRESET` | enum acima, default `polex` | |
| `SHORTS_OVERLAY_TEXT` | `''` | vazio = sem adesivo |
| `SHORTS_OVERLAY_HOLD_SEC` | `2` | |
| `SHORTS_OVERLAY_FADE_SEC` | `0.5` | |
| `SHORTS_OVERLAY_Y` | `0.54` | |
| `SHORTS_OVERLAY_STYLE` | `'' \| capsule \| rect`, default `''` | vazio = preset |
| `SHORTS_OVERLAY_TAG` | `''` | vazio = tag do preset; `none` = sem tag |
| `SHORTS_OVERLAY_UPPERCASE` | `'' \| 'true' \| 'false'`, default `''` | vazio = preset |
| `SHORTS_OVERLAY_BACKGROUND` | `''` (era `#e10600`) | hex opcional; vazio = preset |
| `SHORTS_OVERLAY_COLOR` | `''` (era `#ffffff`) | idem |
| `SHORTS_OVERLAY_BORDER_COLOR` | `''` | idem |
| `SHORTS_OVERLAY_BORDER_PX` | `null` | 0..40; vazio = preset |
| `SHORTS_OVERLAY_SHADOW_COLOR` | `''` | idem |
| `SHORTS_OVERLAY_SHADOW_PX` | `null` | 0..40; idem |
| `SHORTS_OVERLAY_SHADOW_BLUR_PX` | `null` | 0..20; idem |
| `SHORTS_OVERLAY_TILT_DEG` | `null` | −15..15; idem |
| `SHORTS_OVERLAY_FONT` | `'' \| Arial Black \| Impact \| Arial`, default `''` | idem |

Implementação dos tipos opcionais: usar helper no `config.ts` que transforma
`''`/`undefined` em `null` (ex.: `z.preprocess(...).default(null)`); validar hex
com `/^#?[0-9a-f]{6}$/i` quando não vazio e NORMALIZAR para `#rrggbb`
(sem o `#` o SVG sairia com `fill="e10600"`, inválido); tri-state de booleano
como string `''|'true'|'false'` (aceitar também `1/0/on/off` no parse,
gravando `true/false` no painel). `shortsCrossFieldErrors` não muda.

**Env inválido não derruba o bot**: o `getConfig()` valida o `.env` com
tolerância nos campos do adesivo (`parseConfigEnv`): o campo inválido cai no
default/preset e o startup avisa (`invalidShortsOverlayEnvs`). Erro em
qualquer OUTRO campo continua falhando alto.

### 6.4 Renderer (`src/clipper/shortOverlay.ts`)

- `shortOverlayMetrics(text, outWidth, outHeight, style?)`: fonte atual
  (~`min(0.045*W, 0.036*H)`), padding compacto; suportar **quebra de linha**
  (explícita `\n` e automática por largura) com até 3 linhas; altura =
  linhas × lineHeight + paddings. Margem do canvas = espaço para borda + sombra
  + tilt (aumentar em relação aos 16px atuais).
- `shortOverlayButtonSvg`: ordem de desenho:
  1. sombra = forma externa deslocada (`shadowPx,shadowPx`), cor da sombra,
     `feGaussianBlur` só se `shadowBlurPx > 0`;
  2. borda = forma externa preenchida com `borderColor` (se `borderPx > 0`);
  3. fundo = forma interna (gradiente só no `pill`, senão cor chapada);
  4. tag (se houver);
  5. texto (fonte `style.font`, `font-weight=900`, `text-anchor=middle`;
     espelhar o texto para caixa alta quando `uppercase`);
  6. tudo dentro de `<g transform="rotate(tiltDeg, cx, cy)">`.
  - `capsule` = raio = altura/2; `rect` = raio ≈ 14-18. O preset `pill`
    (visual antigo) usa `capsule` + gradiente.
  - `roughEdge` (`diecut`): filtro `feTurbulence`+`feDisplacementMap` na forma.
- `renderShortOverlayButtonPng`: rasteriza o SVG (sharp) no PNG temporário e
  DEVOLVE as métricas REAIS (o texto é medido no renderizador: o `textLength`
  do SVG é ignorado pelo librsvg). Quem posiciona o adesivo usa essas medidas.
- `shortOverlayFilter`: **não muda** (subida/fade já testados). O `yPx` continua
  sendo `layout.height * y - margin` (usar a margem nova).

### 6.5 Assinatura de render (`src/clipper/shorts.ts`)

A `ShortRenderSignature` ganhou um campo por campo visual do adesivo
(`overlayText`, `overlayHoldSec`, `overlayFadeSec`, `overlayY`, `overlayPreset`,
`overlayShape`, `overlayBackground`, `overlayColor`, `overlayBorderColor`,
`overlayBorderPx`, `overlayShadowColor`, `overlayShadowPx`,
`overlayShadowBlurPx`, `overlayTiltDeg`, `overlayFont`, `overlayUppercase`,
`overlayTag`) + `overlayVisuals` (hash do visual dos presets: mudou o preset
no CÓDIGO, o vertical antigo tem que ser refeito).

`shortRenderSignature` aceita os campos opcionais e `isStaleRender` compara
todos (marker antigo sem os campos → `undefined` ≠ atual → re-render,
desejado). Sem isso, trocar preset reaproveita o mp4 antigo.

### 6.6 Script (`scripts/publish-shorts.ts`)

Flags novas (mesmo padrão de `--overlay-text`):
`--overlay-preset`, `--overlay-style`, `--overlay-tag`, `--overlay-uppercase`
(`true|false`), `--overlay-border-color`, `--overlay-border-px`,
`--overlay-shadow-color`, `--overlay-shadow-px`, `--overlay-shadow-blur-px`,
`--overlay-tilt-deg`, `--overlay-font`; e `--caption-font-size`, `--cam-height`.

Wiring:
- Locais `captionFontSize = args.captionFontSize ?? cfg.SHORTS_CAPTION_FONT_SIZE`
  e `camHeight = args.camHeight ?? cfg.SHORTS_CAM_HEIGHT`; substituir TODOS os
  usos de `cfg.SHORTS_CAPTION_FONT_SIZE` e `cfg.SHORTS_CAM_HEIGHT` nas linhas
  ~598/608/612/617 (estilo `.ass` e `topY`), ~922/934 (assinatura), ~1060/1088
  (os dois `renderShortClip`, um deles sem legenda).
- `overlayButton = resolveShortOverlayStyle({ preset: args.overlayPreset ?? cfg.SHORTS_OVERLAY_PRESET,
  text: (args.overlayText ?? cfg.SHORTS_OVERLAY_TEXT).trim(), holdSec: args.overlayHoldSec ?? cfg...,
  fadeSec: args.overlayFadeSec ?? cfg..., y: cfg.SHORTS_OVERLAY_Y, overrides: { ...campos do cfg + flags } })`
  → `null` quando o texto está vazio.
- Assinatura recebe `overlayPreset` e `overlayStyle` (chave do estilo resolvido).
- `renderShortClip` recebe `overlayButton` já resolvido; em `src/clipper/shorts.ts`,
  passar o objeto inteiro para `renderShortOverlayButtonPng` e
  `shortOverlayMetrics` (margem nova).

### 6.7 Painel (`src/trayConfig.ts` + `scripts/tray-panel.html`)

- Adicionar os campos da tabela 6.3 em `EDITABLE_FIELDS` (grupo `clips`;
  detalhes de estilo como `advanced: true`). O painel é data-driven: `select` vem
  de `options`, `number` de `min/max/step`.
- Ajuda em PT deixando claro: **"vazio = valor do preset"**.
- `SHORTS_OVERLAY_PRESET` deve ter `options` com labels legíveis (PolexTV,
  PolexTV die-cut, Gaules, MADHOUSE, Cortes do Rei, Figurinha die-cut, Pílula
  antiga, Personalizado).
- **Limpar overrides ao trocar o preset**: adicionar em `ConfigField` um campo
  opcional `clears?: Array<keyof AppConfig>`; no preset, listar todas as chaves de
  override. No JS do painel (`scripts/tray-panel.html`, handler `change` ~1360),
  ao mudar um select cujo `field.clears` existe, zerar `state.formValues` dessas
  chaves, atualizar os inputs (`value=''`/checkbox) e chamar `updateDirty()`.
- `configValueForPanel`: hoje `raw === undefined ? fallback : raw`; com defaults
  `null` isso mostraria `"null"`. Ajustar para devolver `''` quando o valor
  parseado for `null`. `validateConfigPatch` já valida via schema — garantir que
  `''` passa nos opcionais (preprocess → null).

### 6.8 Docs e testes

Atualizar:
- `README.md`: linhas 578 (`SHORTS_CAM_HEIGHT` 660→600), 598 (54→64) e a tabela
  `SHORTS_OVERLAY_*` (linhas ~601-605) com preset/overrides; exemplos de CLI no
  bloco de Shorts.
- `.env.example`: linhas ~178-188 (comentários + valores; manter hex entre aspas
  `"#e10600"` porque `#` solto é comentário).
- `tests/config.test.ts`: 289 (`600`), 310 (`64`) e novos casos dos opcionais
  (`null` quando vazio, hex inválido rejeitado).
- `tests/shortOverlay.test.ts`: reescrever/expandir — resolução por preset,
  override vence, vazio ignora, `custom`, SVG com sombra sólida/borda/tag/tilt,
  `pill` mantém gradiente, `diecut` contém `feTurbulence`, quebra de linha.
- `tests/shorts.test.ts`: assinatura inclui `overlayPreset`/`overlayStyle`;
  `isStaleRender` true ao trocar preset/estilo (linhas ~484-489).
- `tests/trayConfig.test.ts`: campos novos existem, preset tem options, `clears`
  correto, `configValueForPanel` devolve `''` para `null`, patch aceita `''`.

## 7. Ordem de implementação

1. `src/config.ts`: schema/defaults novos + 64/600.
2. `src/clipper/shortOverlay.ts`: presets, resolver, métricas/SVG/filtro.
3. `src/clipper/shorts.ts`: assinatura + uso do estilo resolvido.
4. `scripts/publish-shorts.ts`: flags + wiring (incl. caption/cam).
5. `src/trayConfig.ts` + `scripts/tray-panel.html`: campos e limpeza.
6. Testes (config, overlay, shorts, trayConfig).
7. README/.env.example.
8. `npm run lint`, `npm test`, `npm run build`.
9. Dry-run visual.

## 8. Verificação

```bash
npm run lint
npm test
npm run build
```

Dry-run visual (escolher um clipe **não publicado** — o YEKINDAR é pulado):

```bash
npx tsx scripts/publish-shorts.ts --dry-run --clip "data/clips/<outro-clipe>" \
  --head-sec 1.5 --tail-sec 6 --min-sec 10 --max-sec 40 \
  --caption-order whisper-cpp,gemini,huggingface \
  --overlay-text "Furia nos playoffs" --overlay-preset polex \
  --caption-font-size 64 --cam-height 600
```

Repetir com `--overlay-preset diecut` (e, se quiser, `madhouse`). Extrair frames
em 0,1/0,6/1,5s com `.tools/ffmpeg.exe -ss <t> -i <short.mp4> -frames:v 1` e
comparar: legenda maior (64), faixa da cam menor (600), adesivo chapado com
sombra sólida/borda/tag conforme preset.

## 9. Armadilhas (ler antes de codar)

- **Clipes publicados são pulados** por `publish-shorts.ts` (linhas ~737-748)
  antes do `--force`. Não tente dry-run no YEKINDAR; use outro clipe ou um mp4
  sintético fora de `data/`.
- **Não editar `.env`** (artefato de produção) nem `data/`, `logs/`.
- `dotenv` com `override: true`: flags de CLI existem justamente para one-off.
- **Fontes do adesivo**: `assets/fonts/*.ttf` são usadas pelo libass (legenda).
  O SVG do sharp usa fontes do sistema via fontconfig (`Arial Black`, `Impact`,
  `Arial`); não tente `@font-face` com o TTF do repo.
- **Emoji** no adesivo não funciona (sem fonte colorida) — não remover
  `stripUnsupportedGlyphs`.
- **ffmpeg**: as vírgulas dentro de `y='...'`/`enable='...'` são protegidas pelas
  aspas simples; não quebrar isso ao mexer no filtro.
- **Assinatura**: qualquer campo visual novo TEM que entrar em
  `shortRenderSignature`/`isStaleRender`, senão o mp4 antigo é reutilizado.
- **Painel**: `EDITABLE_KEYS`/validação usam o schema de `config.ts`; o campo
  opcional precisa aceitar `''`. `configValueForPanel` deve transformar `null`
  em `''`.
- **PowerShell**: `node -e` perde aspas; use here-string. Não use `Set-Content`
  (BOM) para editar arquivos — use as ferramentas de edição.
- Testes puros: nada de rede, ffmpeg real ou credenciais.

## 10. Critérios de aceite

- [x] `npm run lint`, `npm test` e `npm run build` verdes.
- [x] Defaults: legenda 64, cam 600.
- [x] Painel mostra preset + campos; trocar preset limpa overrides; salvar
      grava `.env`.
- [x] CLI `--overlay-preset`/override funciona em todas as combinações e vence
      o `.env`.
- [x] `polex` e `diecut` (e os demais presets) renderizam distintos.
- [x] Trocar preset/estilo no marker força re-render (teste de `isStaleRender`).
- [x] Nada publicado; `2IIlT1udjEQ` intocado.
- [x] `pm2 restart` não executado sem OK do dono.

## 11. Fora de escopo

- Emoji/fontes coloridas no adesivo.
- Publicar ou refazer o Short já no ar.
- Reescrever a legenda para estilo karaokê (palavra destacada).
- Mexer em `SHORTS_ENABLED`/fluxo de publicação.
