# Expansão multi-canal (BR + EN) — plano

> **Status: plano fechado; fases 0 e 1 implementadas (não commitadas).**
> As decisões de produto estão na seção 10; a captura fan-out (fase 2) é o
> próximo passo.
>
> Data: 17/11/2026. Base: commit `d3439b1`. Revisão externa (Claude)
> aplicada em 18/11/2026: isolamento de chaves por canal, fail-closed de
> publicação, backup automático da migração e validação por canal no boot.

---

## 0. TL;DR

- Hoje o bot é **single-tenant em tudo**: um `.env`, um banco, uma pasta de
  clipes, um token do YouTube, uma watchlist, um status e um painel.
- O canal EN **não é o mesmo bot com outro token**: ele grava **outra
  stream** (oficial, não Gaules), então o vídeo do clipe é outro. A única
  coisa realmente compartilhável é a **detecção** (página do HLTV, placar,
  killfeed).
- Recomendação: **um processo, um browser, N runtimes de canal**, com
  **um tracker por canal** na v1 (o tracker NÃO é compartilhado ainda),
  **um banco** com `channel_id`, **pastas e token por canal** e **copy pack
  por idioma**.
- O que **não** fazer: dois processos no mesmo `HLTV_PROFILE`/status;
  `hasAce` global; a mesma pasta de clipe para os dois canais;
  `fixMapPrepositions` no canal EN; cota global sem separar por projeto.
- Fases: **0** config/tipos; **1** banco/pastas/token (BR idêntico);
  **2** captura fan-out (EN grava, não publica); **3** copy + publicação
  16:9 + Shorts EN (sem legenda); **4** painel/scripts; **5** estabilização
  e legenda EN.
- Maior risco: **a janela do clipe**. Por isso a v1 não compartilha o
  tracker e não muda a matemática da janela; só passa a config, o recorder
  e a stream certos para cada canal.

---

## 1. O que é global hoje

| Área | Como está hoje | Precisa ser por canal? |
|---|---|---|
| Config | `src/config.ts`: um schema Zod, um `.env`, `getConfig()` cacheado | **Sim** para o subconjunto de captura/publicação |
| Identidade | não existe `channel_id` | **Sim** (novo) |
| Listing/poll | `fetchMatchListing` já filtra `minStars`/`topTierOnly`/watchlist dentro do page-load; `pollOnce` tem um loop | **Sim** no filtro; **não** no page-load |
| Stream | `selectStream` com `STREAM_PRIORITY`/país/viewers globais | **Sim** |
| Recorders | `activeRecorders` por `matchId`; `MAX_RECORDINGS` global | **Sim** |
| Trackers | `activeTrackers` por `matchId`; um tracker por partida | **Sim** (v1: um por canal) |
| Política de kills | `minKillsFor` usa `activeWatchlist` global e `MIN_KILLS` global | **Sim** |
| Latência | `latencyTracker` global, **keyed por nome da stream**; estado em `CLIP_STREAM_SYNC_STATE_PATH` | **Não** (compartilhar por stream) |
| Referências | `refsCache` por `matchId` | **Não** (compartilhar por partida) |
| Clipes | `CLIPS_DIR` global; pasta `<match>_<map>_r<round>_<player>` | **Sim** |
| Sidecar | `ClipSidecarV2` sem canal | **Sim** (campo `channelId`) |
| Banco | `ace_events UNIQUE(match_id,map,round,player)`, `clips UNIQUE(ace_id,format)`, `discarded_events` | **Sim** (`channel_id` + rebuild do unique) |
| Upload | `YT_*` globais; `uploadClip` recebe credenciais por chamada | **Sim** |
| Cota | `countPublishedClips` conta tudo; `quotaDecision` com teto global | **Sim** (por canal/projeto) |
| Metadados | templates pt-BR em `videoMetadata.ts`; prompt pt-BR em `metadataAi.ts` | **Sim** (copy pack) |
| Copy | `copyRules.ts` é pt-BR ("na Dust2") | **Sim** (no-op/EN) |
| Shorts | `SHORTS_*` globais; `publish-shorts.ts` varre `CLIPS_DIR`; overlay global | **Sim** |
| Legendas | pipeline profundamente pt-BR (`SHORTS_CAPTION_TRANSLATE`, `translateCaptionLines`) | **Sim** (ou desligar no EN v1) |
| Watchlist | `data/watchlist.json` hardcoded em `main.ts`, painel e scripts | **Sim** |
| Status/tray | `data/tray-status.json` único; `otherInstanceAlive` | **Não** no processo único; **sim** no modelo por processo |
| Painel | `.env` + uma watchlist + um status | **Sim** (abas/prefixo) |
| PM2 | uma app `5k-bot` | **Não** no processo único |
| Log | `logs/bot.log` sem campo de canal | **Sim** (campo `channel`) |
| Perfis de IA | `GEMINI_WEB_PROFILE`/`CHATGPT_PROFILE`/`GROK_PROFILE` compartilhados | **Não** (prompt por canal) |
| ffmpeg/ffprobe/yt-dlp | `.tools/` compartilhado | **Não** |

---

## 2. O que precisa ser por canal (e por quê)

| Grupo | Chaves | Por quê |
|---|---|---|
| Captura | `MIN_STARS`, `TOP_TIER_ONLY`, `MIN_KILLS`, `MIN_KILLS_NO_STARS`, `MAX_RECORDINGS`, `WATCHLIST_FILE` | O EN pode querer só top-tier/4K/5K; o BR mantém a política atual |
| Stream | `STREAM_PRIORITY`, `STREAM_PREFERRED_COUNTRY`, `STREAM_PREFERRED_MIN_VIEWERS`, `STREAM_GAULES_FALLBACK`, `STREAM_EN_COUNTRIES` | BR = Gaules/BR (fallback atual); EN = oficial → streamers EN → qualquer, **sem** o boost implícito do Gaules |
| Pastas | `CLIPS_DIR`, `BUFFER_DIR`, `SHORTS_DIR` | O mesmo ace gera **dois vídeos diferentes**; não pode colidir |
| Latência | `CLIP_STREAM_LATENCY_BY_STREAM` (mapa global por stream) | As duas streams têm latências diferentes; o mapa já é keyed por nome |
| Publicação | `YT_UPLOAD`, `YT_PRIVACY`, `YT_CLIENT_SECRETS`, `YT_TOKEN_PATH`, `YT_CATEGORY_ID`, `YT_DEFAULT_TAGS`, `YT_BRAND`, `YT_DESC_CTA`, `YT_QUOTA_UNITS_PER_DAY` | Conta/token/projeto/cota e identidade do canal |
| Shorts | `SHORTS_ENABLED`, `SHORTS_PRIVACY`, `SHORTS_OVERLAY_CONFIG`, `SHORTS_*` de render, `SHORTS_CAPTION_*` | Layout da stream oficial pode ser diferente; legenda tem idioma |
| Copy | `CHANNEL_LANGUAGE`, `CHANNEL_NAME` (novos) | Título/descrição/rodapé/adesivo no idioma do canal |
| Watchlist | `WATCHLIST_FILE` | Times/jogadores e pisos próprios por canal |
| Overlay | `SHORTS_OVERLAY_CONFIG` | Adesivo por clipe, com arquivo por canal |

**O que NÃO deve ser por canal:** `DB_PATH` (um banco com `channel_id`),
`HLTV_PROFILE` (um browser), `LOG_FILE` (um log com `channel`),
`CLIP_STREAM_SYNC_STATE_PATH` (keyed por stream), perfis de IA, bins.

---

## 3. Topologias possíveis

### 3.1 A — um processo, um browser, N runtimes de canal (recomendada)

Um único `dist/src/main.js` (pm2 `5k-bot`). O processo tem:

- **um** browser/contexto persistente do HLTV e **um** fetch de listing;
- **um** `ChannelRuntime` por canal, cada um com seus recorders, trackers,
  streams selecionadas, watchlist, config, pastas e token;
- **um** banco (`channel_id`), **um** status (com seção por canal), **um**
  log (campo `channel`), **um** painel (abas).

Na v1, cada canal abre **seu próprio tracker** (`trackMatch`) na mesma
partida, usando a mesma página do HLTV. O tracker é a peça que produz a
âncora da janela; duplicá-lo mantém o caminho provado intacto. O custo é
uma aba/scorebot extra por partida — aceitável para 2 canais.

**Prós:** menos RAM que dois Chromium; um listing (menos Cloudflare); um
banco/status/painel; cota e logs agregados; a matemática da janela fica
num lugar só; não há conflito de `HLTV_PROFILE`/`otherInstanceAlive`.

**Contras:** um crash/event-loop block afeta os dois canais; o refactor de
`main.ts` (globais → runtime) é o maior trabalho; 2 trackers por partida.

### 3.2 B — um processo por canal

Dois apps pm2 (`5k-bot-br`, `5k-bot-en`), cada um com seu `.env`, perfil,
banco, pastas, token e status.

**Prós:** isolamento total; o código do tracker/janela não muda; dá para
reiniciar/deployar um canal sem o outro; cada processo tem seu limite de
recursos.

**Contras:** dois Chromium (RAM), dois listings/trackers (2x HLTV e
Cloudflare), dois bancos (ou um SQLite com dois writers), dois status/
painéis, `otherInstanceAlive` precisa ser por canal, a cota compartilhada
no mesmo projeto precisa de um ledger comum, e o tray é single-instance.

**Quando escolher:** se o dono quiser isolamento duro, rodar os canais em
máquinas diferentes ou não quiser tocar no `main.ts`.

### 3.3 C — captura compartilhada (um clipe, N uploads)

Gravar uma stream só e subir o mesmo clipe nos dois canais.

**Por que não:** o BR usa Gaules e o EN usa a oficial. O vídeo é outro; a
latência, o crop do placar, o layout do Short e a copy são outros. Só
faria sentido se os dois canais aceitassem a mesma stream — o que
contradiz o requisito.

### 3.4 Comparação

| Critério | A (1 processo) | B (N processos) |
|---|---|---|
| Chromium/HLTV | 1 browser, 1 listing, N trackers | N browsers, N listings/trackers |
| Janela do clipe | não muda a matemática; N trackers | não muda nada |
| Refactor | alto (`main.ts`) | baixo (config/paths/status) |
| Isolamento de falha | médio | alto |
| Banco | 1, com `channel_id` | N (ou 1 com writers) |
| Cota | 1 lugar, por canal/projeto | ledger comum se mesmo projeto |
| Painel/tray | 1, com abas | N status/painéis |
| RAM | menor | maior |
| Recomendação | **v1** | se quiser isolamento duro |

---

## 4. Arquitetura recomendada (A)

### 4.1 Registro de canais e config

- `CHANNELS=br,en` no `.env`. O canal default é **sempre** `br`
  (constante `DEFAULT_CHANNEL_ID`): os dados legados (banco, sidecar,
  token) são do BR. Não existe env para trocar o default — dois "canais
  default" seriam duas configs do mesmo canal.
- **Chaves sem prefixo = canal default (BR)**. O `.env` atual continua
  valendo para o BR; nada precisa ser renomeado. O canal default ignora
  qualquer `BR_*` (o prefixo é do canal default, não dele).
- **Chaves com prefixo = override do canal**: `EN_MIN_STARS`,
  `EN_STREAM_PRIORITY`, `EN_YT_TOKEN_PATH`, etc.
- `getChannelConfig(id)` resolve `EN_KEY ?? KEY ?? default` **somente**
  para as chaves do conjunto `CHANNEL_SCOPED_KEYS`; chaves globais
  (`DB_PATH`, `HLTV_PROFILE`, `LOG_FILE`, `CLIP_STREAM_SYNC_STATE_PATH`,
  perfis de IA, bins) **não** são sobrescrevíveis.
- **Canal fora de `CHANNELS` é erro** (`getChannelConfig`): a config de um
  canal inexistente é herança silenciosa do BR (pasta/token/cota errados).
- **Chave vazia não é override**: `EN_MIN_STARS=` é "não setado" (herda),
  não `0` (sem filtro de estrela). Exceção na allowlist textual
  (`YT_BRAND`, `YT_DESC_CTA`, `CHANNEL_NAME`), onde vazio = "limpa".
- **ISOLAMENTO por canal** (`CHANNEL_ISOLATED_KEYS`): token, secrets, as
  três pastas, watchlist e overlay **não** podem ser herdados pelo canal
  não-default. Sem `EN_YT_TOKEN_PATH`, o `auth:youtube --channel en`
  gravaria por cima do token do BR e o EN publicaria no canal do BR.
  No boot, canal não-default sem essas chaves (ou com o mesmo caminho do
  BR) é **desabilitado** — o BR segue normal.
- **Fail-closed**: para canal não-default, `YT_UPLOAD`/`SHORTS_ENABLED`
  sem valor explícito são **desligados** (o default do schema é ligado, e
  o `.env` do BR tem `YT_UPLOAD=true`/`SHORTS_ENABLED=true`).
- `CHANNEL_LANGUAGE` também é obrigatória no canal não-default (o EN não
  pode herdar `pt-BR`).
- O schema Zod continua sendo a fonte única: `src/config.ts` exporta
  `CHANNEL_SCOPED_KEYS` e `getChannelConfig`; o painel e os validadores
  leem daí. Não duplicar default em outro lugar.
- Validadores de boot (`invalidBoolEnvs`, `invalidShortsOverlayEnvs`,
  etc.) rodam **por canal**, sobre a config efetiva (`EN_YT_UPLOAD=flase`
  não pode cair no default e publicar). `EN_*` fora de
  `CHANNEL_SCOPED_KEYS` é avisado (chave global ou desconhecida).
- No boot, logar a config efetiva de cada canal (sem segredos): estrelas,
  minKills, stream, pastas, token (só o caminho), cota.
- **Alternativa para >3 canais:** `config/channels/<id>.json` com o mesmo
  schema. Não é necessária agora; o `.env` prefixado reaproveita o painel
  e o modelo atual.

**Por que prefixo e não JSON agora:** o painel já edita um `.env` flat com
`EDITABLE_FIELDS`; o prefixo reaproveita o editor, a validação e o
backup. Um JSON aninhado exigiria um editor novo e um segundo caminho de
validação — mais trabalho e mais chance de divergir da "fonte única".

### 4.2 `ChannelRuntime`

Extrair de `main.ts` um objeto por canal:

```ts
interface ChannelRuntime {
  id: string;                       // 'br' | 'en'
  cfg: AppConfig;                   // getChannelConfig(id)
  log: Logger;                      // getLogger().child({ channel: id })
  recorders: Map<string, StreamRecorder>;
  selectedStreams: Map<string, StreamInfo>;
  trackers: Map<string, symbol>;
  watchlist: WatchlistDoc | null;
  pendingClips: Map<string, number>;        // matchId -> contagem
  deferredBufferCleanup: Set<string>;
}
```

**Compartilhado (um por processo):**

- `getBrowser()`/`newTrackedPage()` e o listing;
- `latencyTracker` (keyed por stream) e `CLIP_STREAM_SYNC_STATE_PATH`;
- `refsCache` (keyed por match);
- `getDb(cfg.DB_PATH)` e o logger;
- `metadataAiFn` (uma fila/rate limit; o idioma vai no `ctx`);
- `streamsCache`/`streamsMiss` (fonte é a mesma partida);
- o status agregado e o painel.

**Por canal:** recorders, streams selecionadas, trackers, watchlist,
`pendingClips`, `deferredBufferCleanup`, pastas, token, copy.

**`handleAce(ace, matchId, channel)`**: o `cfg` já é parâmetro hoje; passa a
ser `channel.cfg`. Trocar os globais:

| Global hoje | Vira |
|---|---|
| `activeRecorders.get(matchId)` | `channel.recorders.get(matchId)` |
| `latencyTracker` | compartilhado (keyed por stream) |
| `pendingClips`/`deferredBufferCleanup` | `channel.pendingClips`/`channel.deferredBufferCleanup` |
| `refsCache` | compartilhado (keyed por match) |
| `getMetadataAi()` | compartilhado; `ctx.language` decide o prompt |
| `patchTrayStatus` | `patchChannelStatus(channel.id, ...)` + agregado |
| `getConfig()` dentro do `handleAce` | `channel.cfg` |

O `handleAce` já recebe `cfg` e já tem um `.catch` no `onAce`; a chamada
por canal mantém o erro isolado (`handleAce(...).catch(...)`).

### 4.3 Poll e fan-out

Hoje `fetchMatchListing` faz I/O **e** filtro na mesma função. Separar:

1. `fetchListingCards()` — um page-load, devolve os cards crus +
   `degraded`/`brokenLiveIds`.
2. `buildListing(cards, channel.minStars, channel.topTierOnly,
   channel.watchlist)` — já é puro e testado; roda **uma vez por canal**.
3. O poll agenda usa a **união** dos `upcoming` dos canais (o próximo
   horário que qualquer canal quer).
4. Para cada partida live, cada canal decide se quer gravar e com qual
   stream; `ensureRecorder(channel, match)` e `ensureTracker(channel,
   match)`.
5. A limpeza é por canal; os caches compartilhados (`streamsCache`,
   `streamsMiss`, `refsCache`) só são apagados quando **nenhum** canal
   ainda tem a partida.

```
fetchListingCards()  (1x)
  ├─ buildListing(br) → recorder(br) → tracker(br) → handleAce(br)
  └─ buildListing(en) → recorder(en) → tracker(en) → handleAce(en)
```

**Cuidados de estado compartilhado:**

- `streamsCache`/`streamsMiss`: por partida (fonte). Apagar só quando
  nenhum canal tem a partida ativa.
- `failedStreams`: por **canal + partida + URL**. Uma falha de recorder no
  EN não pode blacklistar a URL para o BR.
- `streamsAllFailedRetry`: por canal + partida.
- `refsCache`: por partida; apagar só quando nenhum canal tem a partida.
- `MAX_RECORDINGS` é por canal; adicionar um **`MAX_TOTAL_RECORDINGS`**
  global (ex.: 6) para o total não virar 8 sem controle. O boot loga o
  efetivo.

**Fallback de stream do EN (decisão de produto).** O EN prefere a oficial,
mas pode cair para outra stream — **primeiro as de idioma inglês**, depois
qualquer uma. Duas descobertas do código atual:

- `StreamInfo.language` **nunca é preenchido** pelo parser do HLTV; o
  único sinal de idioma é a bandeira/país da stream (`country`). Então
  "inglês" vira uma lista configurável de países de transmissão EN:
  `STREAM_EN_COUNTRIES` — **default vazio/desligado** para o BR ficar
  idêntico (o `.env` do BR já usa `official,en`; um default não-vazio
  mudaria o fallback dele). O EN liga com
  `US,GB,AU,CA,IE,NZ,WORLD`.
- O `scoreMainStream` dá +2.000.000 para o Gaules sempre que
  `official`/`en` está na prioridade e não há oficial no ar. Esse é o
  fallback do BR e não pode valer para o EN.

Nova chave `STREAM_GAULES_FALLBACK` (default `true` = comportamento atual):
`EN_STREAM_GAULES_FALLBACK=false` desliga só o boost implícito do Gaules
(o `gaules` explícito na prioridade continua valendo). Com
`EN_STREAM_PRIORITY=official,en`, a ordem vira: oficial → stream de país
EN (+100k) → qualquer stream por viewers, com os restreams BR
penalizados (−500k). `StreamChoice.matchedPriority`
(`official`/`en`/`other`) entra no log/status para diagnosticar quando o
EN não achou oficial.

### 4.4 Tracker e política de kills

**v1: um `trackMatch` por canal**, na mesma `matchPageUrl`, dentro do mesmo
browser/contexto. O `minKillsFor` de cada tracker usa a watchlist e o
`MIN_KILLS`/`MIN_KILLS_NO_STARS` do canal. O `activeTrackers` vira
`channel.trackers`.

Por que não compartilhar o tracker agora:

- o `detectMultiKill` escolhe **o jogador com mais kills que atende ao
  limiar**; com watchlists diferentes, um único limiar compartilhado pode
  escolher o jogador errado para um dos canais;
- o tracker é a fonte da âncora da janela (`startedAt`, `roundEndedAt`,
  `anchorConfidence`); mexer nele é mexer no defeito mais caro do projeto;
- dois trackers custam uma aba/scorebot por partida, não um browser.

**Futuro (depois do EN estável):** fazer o tracker emitir uma
`RoundObservation` (kills do round + telemetria + âncoras) e cada canal
rodar seu próprio `detectMultiKill`. Isso halva as abas, mas exige refactor
do detector e um teste de regressão da janela. Não é v1.

**Chaves globais que o tracker lê hoje** (`SCOREBOARD_DELAY_MS`,
`SCOREBOT_KILLFEED`, `SCOREBOT_LATE_ENRICH_SEC`) continuam globais na v1.
Se o EN precisar de valores diferentes, passar por parâmetro — não ler
`getConfig()` dentro do tracker.

### 4.5 Janela e latência

A matemática da janela **não muda**. O que muda é o input:

- `latencyTracker` continua compartilhado e **keyed pelo nome da stream**
  (`gaules`, `ESL_CS`, ...). Duas streams diferentes não colidem; a mesma
  stream compartilha amostras (desejável).
- `handleAce` usa o recorder e a `streamName` do canal; a latência
  configurada/medida é a da stream daquele canal.
- `CLIP_STREAM_LATENCY_BY_STREAM` cobre as duas streams. A oficial
  normalmente tem latência menor que a Gaules; a medição adaptativa
  aprende, mas o fallback inicial deve ser calibrável.
- `CLIP_SCOREBOARD_CROP_BY_STREAM`/`CLIP_KILLFEED_CROP_BY_STREAM`/
  `SHORTS_CAM_BOX_BY_STREAM` precisam de entradas para a stream oficial.
  O layout do placar da oficial pode ser diferente do da Gaules.
- `CLIP_VALIDATE=on` nos dois canais. O guardrail pós-render é o mesmo;
  clipe com janela inválida é descartado (comportamento esperado).
- Diagnóstico por canal: `npm run diag:clip -- data/clips-en/<pasta>` e
  `npm run diag:clip -- --match <id> --ocr`.

### 4.6 Banco

Um banco (`DB_PATH` compartilhado) com `channel_id`:

```sql
ace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL DEFAULT 'br',
  match_id TEXT NOT NULL,
  map TEXT NOT NULL,
  round INTEGER NOT NULL,
  player TEXT NOT NULL,
  ...,
  UNIQUE(channel_id, match_id, map, round, player)
);

clips (
  ...,
  channel_id TEXT NOT NULL DEFAULT 'br'
);

discarded_events (
  ...,
  channel_id TEXT NOT NULL DEFAULT 'br'
);
```

- `ace_events` precisa de **rebuild** (SQLite não altera constraint
  inline): criar tabela nova, copiar com `channel_id='br'`, dropar,
  renomear, tudo em transação e com backup.
- `clips`/`discarded_events`: `ALTER TABLE ADD COLUMN` idempotente.
- O índice `UNIQUE(ace_id, COALESCE(format,''))` de `clips` continua
  válido: cada canal tem seu próprio `ace_id`.
- `hasAce`, `insertAce`, `insertClip`, `discardAce`,
  `recordDiscardedEvent` passam a receber `channelId`.
- `countPublishedClips(db, since, channelId)` e `findPublishedShorts(db,
  channelId)` filtram por canal. A chave do Short inclui o canal (ou o
  filtro garante que não há mistura).
- `discardAce` de um canal **não** apaga o ace/clipe do outro.
- Se os canais compartilharem o mesmo projeto Google, adicionar
  `quota_project` e somar por projeto; na recomendação (um projeto por
  canal) o `channelId` já é a chave da cota.
- `busy_timeout` só é necessário no modelo B (dois writers); no A, um
  processo escreve.

### 4.7 Pastas e sidecar

**Layout recomendado na v1 (sem mover os dados atuais):**

| Item | BR (atual) | EN (novo) |
|---|---|---|
| Clipes | `./data/clips` | `./data/clips-en` |
| Buffer | `./data/buffer` | `./data/buffer-en` |
| Shorts | `./data/shorts` | `./data/shorts-en` |
| Watchlist | `./data/watchlist.json` | `./data/watchlist-en.json` |
| Overlay | `./config/shorts-overlays.json` | `./config/shorts-overlays-en.json` |
| Token | `./token.json` | `./token-en.json` |
| Client secrets | `./client_secrets.json` | `./client_secrets-en.json` |

Por que **sibling** e não `data/clips/<channel>` agora: o
`publish-shorts.ts` varre os filhos diretos de `CLIPS_DIR`; se o EN
ficasse em `data/clips/en`, o scanner do BR poderia tratar a pasta `en`
como um clipe. Sibling evita mover `data/` e evita o aninhamento. A
migração para `data/clips/<channel>` fica como limpeza futura.

**Sidecar:** adicionar `channelId` no topo do `ClipSidecarV2` (campo
opcional; v2 continua). O `buildClipSidecar` recebe `channelId`; o
`normalizeClipSidecar` lê o campo e, quando ausente, usa o canal default
(`br`) — os sidecars antigos continuam válidos. O `ShortMarkerV2` também
ganha `channelId`.

**Escrita:** sempre `writeClipSidecar()`/`writeShortMarker()` (atômica
`.tmp`+`rename`); nunca `fs.writeFileSync` direto.

**Pastas de clipe:** o nome `<match>_<map>_r<round>_<player>` pode se
repetir entre canais (mesmo ace), mas as pastas ficam em `CLIPS_DIR`
diferentes. O `channelId` no sidecar/DB desambigua se um clipe for movido.

**Overlay:** a chave continua sendo o nome da pasta do clipe. Como cada
canal tem seu próprio arquivo, a mesma chave nos dois arquivos não colide.

**Scripts:** `publish-shorts --channel <id>` (ou inferir do caminho
`data/clips-en/...`); `enrich-clip`, `organize-clips`, `upload-vod-clips`,
`check-metadata`, `sync-report` ganham `--channel` ou inferem do caminho.

### 4.8 YouTube, cota e credenciais

- Token/projeto **por canal**. O `loadOAuthClient(clientSecretsPath,
  tokenPath)` já é por chamada; basta passar os caminhos do canal.
- **Cota é por projeto Google Cloud, não por canal.** Dois tokens do
  mesmo projeto dividem 10.000 units/dia (~6 uploads de 1.600). A
  recomendação é **um projeto por canal** (10k/dia cada). Se o dono
  preferir um projeto só, o guard precisa somar os canais do mesmo
  projeto (`quota_project`) — senão os dois acham que têm a cota inteira.
- `YT_QUOTA_UNITS_PER_DAY` por canal/projeto; `YT_QUOTA_TIMEZONE`
  continua global (dia do Pacífico).
- `countPublishedClips` filtra por canal (ou projeto). O custo de
  thumbnail (50u) continua fora da conta atual; é um undercount conhecido.
- `auth-youtube --channel en` e `check-youtube --channel en`.
- **Auditoria do projeto:** projeto novo da Data API só publica vídeo
  não-privado depois da auditoria de conformidade. Pedir a auditoria na
  criação do projeto do EN; até aprovar, o upload pode ser forçado a
  `private` mesmo com `YT_PRIVACY=unlisted` (a decisão de produto não
  muda; o valor efetivo aparece no status).
- Uploads concorrentes: um semáforo global (1–2 uploads ao mesmo tempo)
  evita saturar o link; a fila de metadados já serializa a IA.
- **`.gitignore`:** os padrões atuais são exatos (`token.json`,
  `client_secrets.json`). Trocar para `token*.json` e
  `client_secrets*.json` **antes** de criar os arquivos do EN.

### 4.9 Copy e idioma

Criar um `CopyPack` puro por idioma:

```ts
interface CopyPack {
  id: 'pt-BR' | 'en';
  mapWithArticle(map: string): string;       // "na Dust2" | "on Dust2"
  fixMapPrepositions(text: string): string;  // BR: corrige; EN: identidade
  titleTemplates: TitleTemplate[];
  shortTitle(ctx: MetadataContext): string;
  description(ctx: MetadataContext, opts: MetadataOptions): string;
  footer(ctx: MetadataContext, opts: MetadataOptions): string;
  tags(ctx: MetadataContext, defaults: string[], opts: { shorts: boolean }): string[];
  aiPrompt(ctx: MetadataContext): string;
  aiSystemPrompt: string;
}
```

**Onde a copy pt-BR está hoje (auditar todos):**

| Arquivo | O que tem | Ação |
|---|---|---|
| `src/clipper/copyRules.ts` | `FEMININE_MAP_NAMES`, `fixMapPrepositions`, `mapWithArticle` | Vira `ptBRCopyPack`; `enCopyPack` é no-op/`on` |
| `src/uploader/videoMetadata.ts` | `TITLE_TEMPLATES` (12+), `buildShortTitle`, `buildTemplateDescription`, `buildFooter`, `sanitizeTitle`/`sanitizeDescription` chamam `fixMapPrepositions`, `usedTitles` | Copy pack + `ctx.language`; `usedTitles` por canal |
| `src/uploader/metadataAi.ts` | prompt e system prompt pt-BR; `facts` com chaves pt | Prompt EN + system EN; `ctx.language` |
| `src/clipper/clipBuilder.ts` | `buildTitle`/`buildDescription` legado pt-BR | Só para `YT_META_MODE=legacy`; EN usa `ai`/`template` |
| `src/clipper/shortOverlay.ts` | `resolveShortOverlayText` aplica `fixMapPrepositions` sempre | Receber copy pack/idioma |
| `src/clipper/shortCaptions.ts` | `fixMapPrepositions` na legenda; `translateCaptionLines` pt-BR; heurística `looksPortuguese` | EN: sem tradução pt-BR; ver 4.10 |
| `src/clipper/aiThumbnail.ts` | prompt pt-BR (interno); texto visível é nome/evento/label | Não vaza idioma; branding pode ficar global na v1 |
| `src/uploader/youtubeUploader.ts` | fallback `buildTitle`/`buildDescription` | EN sempre passa `metadata` |

**Regra de ouro:** o `fixMapPrepositions` do BR **nunca** roda no canal
EN. O EN usa "on Dust2"; o BR continua "na Dust2". Testes de snapshot
para os dois packs.

**`replayOnly`:** o `uploadClip` adiciona "(replay do round — ...)" em
pt-BR mesmo quando recebe metadata. No EN, essa nota precisa vir do copy
pack (ou ser passada como opção) para não vazar português.

**Validação:** `validateTitle`/`validateDescription` são quase
language-neutral (tamanho, URL, emoji, nome do jogador, evento/time,
fatos numéricos). Auditar `factualClaims`/`namesUnknownRival` para o EN;
o check de "ace" é compatível com inglês.

**Templates EN:** começar com um pool mínimo (5–6 templates) + AI; o
template é o fallback determinístico e precisa existir em EN. Expandir
depois com dados reais.

**`usedTitles`/`templateRotation`/`lastTemplateId`** são module-level;
`usedTitles` precisa ser por canal (senão um título usado no BR bloqueia
o EN). `templateRotation` pode ficar compartilhado, mas o ideal é por
canal.

### 4.10 Shorts e legendas

- `SHORTS_ENABLED`, `SHORTS_PRIVACY`, `SHORTS_*` de render e
  `SHORTS_OVERLAY_CONFIG` por canal.
- `publish-shorts --channel <id>`: varre `cfg.CLIPS_DIR` do canal, usa o
  token/cota/overlay/idioma do canal, filtra o DB por canal e deduplica
  por canal.
- **Layout da stream oficial:** o `SHORTS_TOP='cam'`/`SHORTS_CAM_BOX`
  assume um layout de cam. A oficial pode ter cam em outro canto ou não
  ter. **Decisão: Shorts EN ligados junto com o 16:9** — o layout da
  oficial precisa estar calibrado ANTES do primeiro upload (testar um
  clipe EN e calibrar `SHORTS_CAM_BOX_BY_STREAM`/`SHORTS_TOP`/
  `SHORTS_GAME_*` por canal). Se a oficial não tiver cam, o Short precisa
  de um preset sem cam.
- **Legendas (decisão):** Shorts EN **sem legenda queimada** na v1
  (`EN_SHORTS_CAPTIONS=false`). O pipeline é profundamente pt-BR (tradução
  para pt-BR, review em português, heurística `looksPortuguese`, campo
  `text_pt`): ligar hoje colocaria legenda em português num canal em
  inglês. Legenda EN é fase própria:
  - pular a tradução pt-BR;
  - review prompt em inglês (ou desligar `SHORTS_CAPTION_REFINE`);
  - heurística de idioma generalizada;
  - não usar o Vosk pt-BR no EN (Whisper/Gemini/HF).
- **Adesivo:** `resolveShortOverlayText` precisa do copy pack; o `auto`
  do EN não pode passar pelo `fixMapPrepositions` do BR.

### 4.11 Painel, status e operação

**Painel (`scripts/tray-panel.ts` + `src/trayConfig.ts`):**

- Abas: **Global | BR | EN**.
- Campos de canal usam o prefixo (`EN_*`); o editor/validação/backup
  reaproveitam `EDITABLE_FIELDS` com um `prefix`.
- `validateConfigPatch` valida a config **efetiva** do canal (global +
  prefixo), não o patch cru.
- Watchlist editor usa o arquivo do canal.
- Status mostra recorders/trackers/último clipe/cota/erro por canal.
- "Reiniciar" reinicia a app pm2 (uma no modelo A).

**Status (`src/trayStatus.ts`):**

- Manter o topo como **agregado** (`phase`, `totals`, `matches`,
  `pendingClips`, `lastClip`, `lastError`) para o tray atual continuar
  funcionando; adicionar `channels: Record<string, TrayChannelStatus>`
  com o detalhe.
- `version` 2; o painel/tray leem v1/v2.
- `otherInstanceAlive` continua lendo `pid`/`heartbeatAt` do topo (um
  processo).

**Logs:**

- `getLogger().child({ channel: id })` no runtime; os logs do
  `handleAce`/recorder/tracker herdam o campo.
- `scripts/explain.ts` ganha `--channel` (filtra o JSON por linha).
- `notifyWindows` inclui o canal no título/corpo.

**PM2:** no modelo A, `ecosystem.config.cjs` não muda; `npm run build` +
`pm2 restart 5k-bot` (manual, do dono).

---

## 5. Contratos/invariantes

1. **Toda chave de dado tem canal:** DB (`channel_id`), sidecar/marker
   (`channelId`), pasta (`CLIPS_DIR` do canal), dedup (`hasAce` por
   canal), cota (canal/projeto).
2. **Nenhum dedup cruzado:** o mesmo ace pode (e deve) gerar um clipe por
   canal; `hasAce`/`insertClip`/`findPublishedShorts` nunca bloqueiam o
   outro canal.
3. **A janela é por canal/stream:** a matemática não muda; o recorder, a
   `streamName` e a latência são do canal. Não compartilhar a janela
   calculada entre canais.
4. **Copy é por idioma:** o `fixMapPrepositions` do BR não roda no EN;
   "na Dust2" vs "on Dust2" é testado.
5. **Cota é por projeto:** dois canais no mesmo projeto somam; um projeto
   por canal é a recomendação.
6. **Sidecar/marker atômicos:** `writeClipSidecar`/`writeShortMarker`.
7. **Migração de dados é reversível:** o rebuild de `ace_events` roda no
   boot, mas sempre com **backup automático** (`<db>.pre-channel.bak`,
   via `VACUUM INTO`), contagem antes/depois e `foreign_key_check`. O
   script `npm run db:migrate` é o caminho de inspeção (dry-run por
   padrão) e de backup explícito.
8. **BR idêntico até o EN ligar:** toda fase tem um gate "o BR continua
   igual" (mesmos clipes, mesmas janelas, mesmo upload).
9. **Um processo, um browser, um status** no modelo A; nada de dois
   processos no mesmo perfil/status.
10. **Erro de um canal não derruba o outro:** config inválida de canal
    não-default desabilita só ele; `handleAce` por canal com `.catch`;
    upload/thumbnail/metadata isolados.
11. **Recursos têm teto global:** `MAX_TOTAL_RECORDINGS`, disco, uploads
    concorrentes e fila de IA.
12. **Segredos não versionados:** `/token*.json`/`/client_secrets*.json`
    no `.gitignore`; `.env` já é ignorado.
13. **Canal não-default é fail-closed:** publicação/Shorts desligados sem
    valor explícito; token/pastas/watchlist/overlay próprios; canal fora
    de `CHANNELS` é erro.

---

## 6. Mudanças por arquivo

| Arquivo | Mudança | Risco |
|---|---|---|
| `src/config.ts` | `CHANNELS`, `CHANNEL_SCOPED_KEYS`, `CHANNEL_ISOLATED_KEYS`, `getChannelConfig`, `WATCHLIST_FILE`, `STREAM_GAULES_FALLBACK`, `STREAM_EN_COUNTRIES`, `MAX_TOTAL_RECORDINGS`, validação por canal | médio |
| `src/env.ts` | nada (o `.env` já é lido inteiro) | baixo |
| `src/main.ts` | `ChannelRuntime`; `pollOnce` por canal; `fetchListingCards`; `ensureRecorder/Tracker`; `handleAce` por canal; limpeza compartilhada; status por canal | **alto** |
| `src/monitor/hltvMonitor.ts` | separar `fetchListingCards` de `buildListing`; `StreamChoice.matchedPriority`/`STREAM_GAULES_FALLBACK`; `fetchMatchListing` vira wrapper | médio |
| `src/monitor/pollSchedule.ts` | agenda pela união dos `upcoming` | baixo |
| `src/detector/matchTracker.ts` | nada na v1 (tracker por canal); no futuro, `RoundObservation` | baixo (v1) |
| `src/detector/aceDetector.ts` | nada na v1 | baixo |
| `src/db.ts` | `channel_id`, rebuild de `ace_events`, assinaturas por canal, `countPublishedClips`/`findPublishedShorts` por canal | **alto** |
| `src/clipper/sidecar.ts` | `channelId` no `ClipSidecarV2`/`ShortMarkerV2`; `buildClipSidecar`/`normalizeClipSidecar` | médio |
| `src/clipper/copyRules.ts` | `CopyPack` pt-BR/EN | médio |
| `src/uploader/videoMetadata.ts` | templates/footer/tags/sanitize por copy pack; `usedTitles` por canal | **alto** (copy) |
| `src/uploader/metadataAi.ts` | prompt/system por idioma | médio |
| `src/clipper/clipBuilder.ts` | legado pt-BR; EN não usa `legacy` | baixo |
| `src/clipper/shortOverlay.ts` | copy pack no `resolveShortOverlayText` | médio |
| `src/clipper/shortCaptions.ts` | EN v1 sem legenda; fase futura de EN | alto se mexer agora |
| `src/uploader/youtubeUploader.ts` | credenciais já por chamada; nota de `replayOnly` e fallback legado precisam do copy pack/idioma | médio |
| `src/uploader/quota.ts` | nada; o chamador passa o usado por canal/projeto | baixo |
| `src/trayStatus.ts` | `channels` + agregado; `patchChannelStatus`; config por canal | médio |
| `src/trayConfig.ts` | `CHANNEL_SCOPED_KEYS`/prefixo; validação efetiva | médio |
| `src/watchlist.ts` | nada (já recebe path); paths por canal no chamador | baixo |
| `src/logger.ts` | nada; child com `channel` no runtime | baixo |
| `scripts/tray-panel.ts` | abas, prefixo, watchlist/status por canal | **alto** (UI) |
| `scripts/tray-panel.html` | abas/seletor de canal | médio |
| `scripts/bot-tray.ps1` | ler o agregado do status (e, se quiser, o detalhe por canal) | baixo |
| `scripts/publish-shorts.ts` | `--channel`, paths/token/cota/overlay/idioma/dedup por canal | **alto** |
| `scripts/auth-youtube.ts` | `--channel` | baixo |
| `scripts/check-youtube.ts` | `--channel` | baixo |
| `scripts/enrich-clip.ts` | inferir canal do caminho / `--channel` | baixo |
| `scripts/organize-clips.ts` | idem | baixo |
| `scripts/upload-vod-clips.ts` | idem | baixo |
| `scripts/check-metadata.ts` | idem | baixo |
| `scripts/sync-report.ts` | idem | baixo |
| `scripts/explain.ts` | `--channel` | baixo |
| `scripts/check-live.ts` / `watchlist-check.ts` | `--channel`/watchlist do canal | baixo |
| `ecosystem.config.cjs` | nada no modelo A; N apps no modelo B | baixo |
| `package.json` | script de migração (`db:migrate`) | baixo |
| `.env.example` | `CHANNELS`/`EN_*` comentados | baixo |
| `docs/watchlist.example.json` | exemplo/instrução para a watchlist EN | baixo |
| `.gitignore` | `/token*.json`, `/client_secrets*.json` | **alto** (segurança) |
| `README.md` | seção multi-canal, env, cota, rollout | baixo |
| `AGENTS.md` | invariantes multi-canal | baixo |
| `docs/janela-do-clipe.md` | nota "janela por canal/stream" | baixo |
| `config/shorts-overlays-en.json` | novo (overlay do EN) | baixo |
| `data/watchlist-en.json` | novo (via painel; `data/` é gitignored) | baixo |
| `tests/*` | config/DB/sidecar/copy/quota/painel/scripts | — |

---

## 7. Migração

**Princípio:** o BR não pode mudar de comportamento no dia 1. A migração
do banco é a única etapa destrutiva; tudo o mais é aditivo.

### 7.1 Backup (obrigatório, antes de tudo)

- `.env` → `.env.bak`
- `data/bot.sqlite` → `data/bot.sqlite.pre-channel.bak` (o bot cria
  sozinho, com `VACUUM INTO`, antes do rebuild; `npm run db:migrate
  -- --apply` cria o mesmo arquivo e não sobrescreve um anterior)
- `data/clips` (ou pelo menos o DB + sidecars) → cópia
- `data/watchlist.json` → cópia
- `config/shorts-overlays.json` → cópia
- `token.json`/`client_secrets.json` → cópia (não versionar)

### 7.2 Passos

1. **Config:** adicionar `CHANNELS=br,en` e as chaves `EN_*` (isoladas:
   token, secrets, pastas, watchlist, overlay, idioma); o BR continua sem
   prefixo.
2. **`.gitignore`:** `/token*.json`, `/client_secrets*.json`.
3. **Banco:** rodar `scripts/migrate-db.ts` (novo) em **dry-run**;
   conferir o plano; rodar `--apply` com o bot parado.
   - rebuild de `ace_events` com `UNIQUE(channel_id, ...)`;
   - `ALTER TABLE` de `clips`/`discarded_events`;
   - todas as linhas existentes viram `channel_id='br'`;
   - backup automático antes do rebuild + contagem antes/depois +
     `foreign_key_check`.
   - (o bot faz a mesma migração sozinho no boot, sempre com backup)
4. **Pastas:** **não mover** as do BR na v1. Criar `data/clips-en`,
   `data/buffer-en`, `data/shorts-en` quando o EN for ligado.
5. **Sidecar:** os antigos não têm `channelId`; o reader assume `br`.
   Backfill opcional com `updateClipSidecar` (nunca escrita direta).
6. **Watchlist/overlay:** BR fica nos arquivos atuais; EN ganha
   `data/watchlist-en.json` e `config/shorts-overlays-en.json`.
7. **Token/projeto:** criar o projeto/conta do EN, rodar
   `auth-youtube --channel en`, `check-youtube --channel en`.
8. **Painel/status:** atualizar; o topo do status continua agregado.
9. **Ligar o EN em etapas:** gravar → cortar → publicar `unlisted` (ou
   `private` se a auditoria ainda não liberar) → Shorts.

### 7.3 Rollback

- Código: voltar o commit; as colunas `channel_id` são ignoradas pelo
  código antigo **exceto** o unique de `ace_events` (o rebuild muda a
  constraint). Para reverter de verdade, restaurar
  `data/bot.sqlite.pre-channel.bak` (com o bot parado).
- Pastas/tokens do EN: remover/ignorar; o BR não depende deles.
- `.env`: restaurar `.env.bak`.
- O dry-run do script de migração deve imprimir o SQL e as contagens
  antes/depois.

---

## 8. Fases e critérios de aceite

Toda fase termina com `npm run lint`, `npm test` e `npm run build`.

### Fase 0 — Config, tipos e sidecar (sem mudar comportamento)

- `CHANNELS`/`CHANNEL_SCOPED_KEYS`/`CHANNEL_ISOLATED_KEYS`/`getChannelConfig`.
- `channelId` no sidecar/marker (obrigatório na leitura; ausente = `br`).
- `WATCHLIST_FILE`, `STREAM_GAULES_FALLBACK`, `STREAM_EN_COUNTRIES`,
  `MAX_TOTAL_RECORDINGS` no schema (as três últimas são **reservadas**
  para a fase 2 — ainda não são lidas pelo bot).
- Log de config efetiva por canal no boot; canal não-default sem
  isolamento é desabilitado (sem derrubar o BR).

**Aceite:** BR idêntico; testes de overlay de config; sidecar antigo lê
`br`; `npm run lint/test/build` verdes.

### Fase 1 — Banco, pastas e token (BR idêntico)

- Migração do DB (com backup automático) + assinaturas por canal.
- Paths por canal (BR atual, EN novos).
- `.gitignore`; `auth:youtube --channel` (recusa token existente sem
  `--force` e recusa canal sem isolamento).
- Testes de migração e de dedup por canal.

**Aceite:** um clipe BR novo entra/sai igual; `countPublishedClips('br')`
bate com o total antigo; inserir o mesmo ace em `en` cria linha separada;
dry-run da migração em cópia do DB de produção.

### Fase 2 — Captura fan-out (EN grava, não publica)

- `ChannelRuntime`; `pollOnce` por canal; `fetchListingCards`;
  `ensureRecorder/Tracker`; limpeza compartilhada.
- `EN_YT_UPLOAD=false`; `EN_SHORTS_ENABLED=false`.
- Um tracker por canal; `minKillsFor` por canal.

**Aceite:** BR com os mesmos clipes/janelas de antes; EN grava a stream
escolhida (oficial quando existe; senão EN/outra, sem o boost do Gaules) e
gera clipe; `diag:clip` do EN passa; nenhum dedup cruzado;
`MAX_TOTAL_RECORDINGS` respeitado; logs com `channel`.

### Fase 3 — Copy, publicação 16:9 e Shorts EN (unlisted)

- `CopyPack` pt-BR/EN; templates/footer/tags; prompt/system EN;
  `usedTitles` por canal; overlay copy-aware.
- `uploadClip`/metadata/quota por canal.
- `EN_YT_PRIVACY=unlisted`; auditoria do projeto Google pedida no início
  (projeto não auditado pode forçar `private` — ver 4.8).
- `publish-shorts --channel en`; layout/cam box da oficial calibrado;
  `EN_SHORTS_ENABLED=true` junto com o 16:9; **sem legenda**
  (`EN_SHORTS_CAPTIONS=false`).

**Aceite:** clipe EN sobe unlisted com título/descrição/tags em inglês;
nenhuma frase pt-BR ("na Dust2") no EN; BR inalterado; cota do EN
contada separada; 5–10 clipes e 3–5 Shorts revisados; Short vertical sem
cam preta/duplicada.

### Fase 4 — Painel, status e scripts

- Abas/prefixo; watchlist/status/cota por canal; restart.
- `publish-shorts --channel`; scripts com `--channel`.
- README/AGENTS/docs.

**Aceite:** editar EN não mexe no BR; status mostra os dois; `publish-shorts`
do EN usa o overlay/token/cota do EN; `explain --channel` filtra.

### Fase 5 — Estabilização e legenda EN

- Monitorar uma semana: cota, disco, logs, erros, janela dos clipes.
- Ajustar templates/tags/CTA com os dados reais.
- Legenda EN (opcional): pipeline próprio (sem tradução pt-BR, review em
  inglês, Vosk fora).
- Decidir `public` quando o canal tiver histórico e a auditoria estiver
  aprovada.

**Aceite:** duas semanas sem regressão do BR; nenhum clipe EN com copy
pt-BR; erros de cota/limite visíveis no painel.

---

## 9. Riscos

| Risco | Impacto | Mitigação | Como detectar |
|---|---|---|---|
| Regressão da janela | **alto** (clipe publicado não volta) | v1 com tracker por canal; não mudar a matemática; `CLIP_VALIDATE=on`; comparar BR antes/depois; `diag:clip` no EN | clipe abre no replay/perde kill; `diag:clip --ocr` |
| Cota estourada | **alto** (upload falha ou público sem cota) | um projeto por canal; `countPublishedClips` por canal; começar `private`/`unlisted` conforme a auditoria; conferir o Console | erro 403 quota; `quotaDecision` |
| Migração do DB | **alto** (perda de histórico) | backup automático antes do rebuild; `tx.immediate()`; contagem antes/depois; `foreign_key_check`; dry-run do script | contagem antes/depois; `foreign_key_check`; log de backup |
| Cloudflare/HLTV 2x | médio | um browser/listing; tracker por canal só na v1; backoff; cap de partidas | clearance/listing degradado |
| CPU/disco 2x | médio | `MAX_TOTAL_RECORDINGS`; `MAX_RECORDINGS` por canal; `DISK_MIN_FREE_GB`; limpeza | fila/ffmpeg/disco |
| Copy pt-BR vazando no EN | médio | copy pack; snapshots; revisão dos 10 primeiros | título/descrição com "na"/"no" |
| Shorts da oficial | médio | calibrar layout/cam box antes do 1º upload; preset sem cam se preciso | cam preta/duplicada |
| Legenda EN | médio | `EN_SHORTS_CAPTIONS=false` na v1; fase própria | legenda em português num canal EN |
| Dedup cruzado | **alto** | `channel_id` em tudo; testes | EN sem clipe/BR sobrescrito |
| Um processo cai | médio | pm2; erros isolados por canal; health check | status/erro |
| IA/thumbnail saturada | médio | fila global; template fallback; semáforo | tempo de metadata/thumb |
| Config drift no painel | médio | prefixo validado; config efetiva logada | painel vs log |
| Canal novo herdando o BR | **alto** (publica no canal errado) | chaves isoladas obrigatórias; fail-closed; canal fora de `CHANNELS` é erro | aviso "canal desabilitado" no boot |

---

## 10. Decisões tomadas

Fechadas em 17/11/2026. A arquitetura da seção 4 já reflete estas escolhas.

| # | Decisão | Escolha | Consequência |
|---|---|---|---|
| 1 | Topologia | **A: um processo, N runtimes** | `main.ts` vira `ChannelRuntime`; um browser/listing/DB/status; um tracker por canal |
| 2 | Política do EN | **top-tier 4K/5K**: `MIN_STARS=3`, `TOP_TIER_ONLY=true`, `MIN_KILLS=4`, `MIN_KILLS_NO_STARS=5` | menos volume; o log de "round fechado" mostra o que faltou |
| 3 | Stream do EN | **oficial → EN → qualquer**, fallback permitido e **sem** o boost implícito do Gaules | `STREAM_GAULES_FALLBACK`/`STREAM_EN_COUNTRIES`; `EN_STREAM_GAULES_FALLBACK=false`; `EN_STREAM_PRIORITY=official,en` |
| 4 | Privacidade | **unlisted desde o início** | pedir a auditoria do projeto Google no dia 1; projeto não auditado pode forçar `private` (restrição técnica, ver abaixo) |
| 5 | Shorts EN | **ligados junto com o 16:9**, sem legenda queimada | calibrar layout/cam box antes do 1º upload; `EN_SHORTS_CAPTIONS=false`; legenda EN fica para a fase 5 |
| 6 | Projeto Google | **um por canal** (10k/dia cada) | `EN_YT_CLIENT_SECRETS`/`EN_YT_TOKEN_PATH` próprios; sem ledger |
| 7 | Banco | **um DB com `channel_id`** | rebuild de `ace_events`; dedup/cota por canal |
| 8 | Config | **`.env` prefixado** (`EN_*`) | BR sem prefixo continua idêntico; painel/validação reaproveitados |
| 9 | Watchlist EN | **separada, começando vazia** | `EN_WATCHLIST_FILE=./data/watchlist-en.json`; EN entra só pela política de estrelas até você popular |
| 10 | Cadência | 6 uploads/dia por canal é o teto de 10k | medir e pedir aumento se precisar |
| 11 | Identidade EN | nome/brand/CTA/tags próprios | preencher `EN_YT_BRAND`/`EN_YT_DESC_CTA`/`EN_YT_DEFAULT_TAGS` |
| 12 | Revisão | revisar os primeiros 5–10 16:9 e 3–5 Shorts | mesmo `unlisted`, a revisão evita copy errada |
| 13 | Canal default | **sempre `br`** (constante, sem env) | dados legados e runtime BR são do `br`; `BR_*` é ignorado |
| 14 | Isolamento | token/secrets/pastas/watchlist/overlay **obrigatórios** no canal não-default | sem eles o canal herdaria o BR (token sobrescrito, clipe colidindo) |
| 15 | Fail-closed | `YT_UPLOAD`/`SHORTS_ENABLED` desligados no canal não-default sem valor explícito | canal novo não publica por acidente |
| 16 | Migração | automática no boot, **com backup automático** (`<db>.pre-channel.bak`) | o script `db:migrate` é a inspeção/backup explícito; a volta está sempre no disco |

**Ponto de atenção da decisão 4:** a auditoria de conformidade do YouTube
(Data API) é o que libera vídeo não-privado. Se o projeto do EN ainda não
estiver auditado, o upload pode sair `private` mesmo com
`EN_YT_PRIVACY=unlisted` — nesse caso o valor é técnico, não uma mudança
da decisão. Pedir a auditoria junto com a criação do projeto e só fechar o
gate da fase 3 quando o `unlisted` funcionar de fato.

---

## 11. Rollout EN (checklist)

1. Criar o canal/brand account do EN e o projeto Google Cloud (um projeto
   por canal). **Pedir a auditoria de conformidade da Data API** junto com a
   criação — é ela que libera `unlisted`.
2. Ativar YouTube Data API v3; OAuth Desktop; consent screen em
   **production** (test mode costuma falhar com brand account).
3. Baixar `client_secrets-en.json`; `npm run auth:youtube -- --channel en`;
   gerar `token-en.json`.
4. `npm run check-youtube -- --channel en`.
5. Preencher `EN_*` no `.env`; `EN_YT_UPLOAD=false`,
   `EN_SHORTS_ENABLED=false`, `EN_MAX_RECORDINGS=2` (fase 2: só grava).
6. Rodar uma partida live; conferir:
   - recorder do EN na oficial (ou na stream EN de fallback, com o motivo
     no log/status);
   - tracker do EN com a política de kills;
   - clipe em `data/clips-en/...` + sidecar com `channelId: "en"`;
   - `npm run diag:clip -- data/clips-en/<pasta>`;
   - `npm run diag:clip -- --match <id> --ocr` (calibrar crop/latência).
7. Comparar a janela do BR e do EN no mesmo ace (devem ser clipes
   diferentes, mas ambos com 1ª/última kill).
8. Ligar `EN_YT_UPLOAD=true`, `EN_YT_PRIVACY=unlisted`; revisar 5–10.
   Se a auditoria ainda não estiver aprovada e a API forçar `private`,
   manter `private` até liberar (registrar no painel).
9. Ajustar copy/templates/tags; repetir.
10. Ligar `EN_SHORTS_ENABLED=true` junto com o 16:9; calibrar cam box com
    um clipe da oficial; revisar 3–5; manter `EN_SHORTS_CAPTIONS=false`.
11. Monitorar cota, disco, logs e erros por uma semana.
12. Atualizar README/AGENTS/docs com o que aprendeu.

---

## 12. Futuro (fora do v1)

- **Tracker compartilhado** emitindo `RoundObservation` + `detectMultiKill`
  por canal (halva abas/scorebots).
- **Layout uniforme** `data/clips/<channel>` (migração de pastas).
- **`config/channels/<id>.json`** para >3 canais.
- **Legenda EN** com review prompt em inglês e heurística generalizada.
- **Recorder compartilhado** quando dois canais usarem a mesma stream.
- **Branding/thumbnail por canal** (cores, logo, fonte).
- **Ledger de cota por projeto** se os canais compartilharem projeto.
- **Múltiplas máquinas/workers** (fila de captura/publicação).

---

## Apêndice A — exemplo de `.env` (EN)

```dotenv
# Registro (global)
CHANNELS=br,en
MAX_TOTAL_RECORDINGS=6

# BR: sem prefixo (config atual)
MIN_STARS=2
TOP_TIER_ONLY=false
MIN_KILLS=4
MIN_KILLS_NO_STARS=5
STREAM_PRIORITY=official,en
STREAM_PREFERRED_COUNTRY=BR
STREAM_PREFERRED_MIN_VIEWERS=2000
MAX_RECORDINGS=4
CLIPS_DIR=./data/clips
BUFFER_DIR=./data/buffer
SHORTS_DIR=./data/shorts
WATCHLIST_FILE=./data/watchlist.json
SHORTS_OVERLAY_CONFIG=./config/shorts-overlays.json
YT_CLIENT_SECRETS=./client_secrets.json
YT_TOKEN_PATH=./token.json
YT_PRIVACY=unlisted

# EN: prefixo (chaves ISOLADAS são obrigatórias)
EN_CHANNEL_NAME=...
EN_CHANNEL_LANGUAGE=en
EN_MIN_STARS=3
EN_TOP_TIER_ONLY=true
EN_MIN_KILLS=4
EN_MIN_KILLS_NO_STARS=5
EN_STREAM_PRIORITY=official,en
EN_STREAM_PREFERRED_COUNTRY=
EN_STREAM_PREFERRED_MIN_VIEWERS=0
EN_STREAM_GAULES_FALLBACK=false
EN_STREAM_EN_COUNTRIES=US,GB,AU,CA,IE,NZ,WORLD
EN_MAX_RECORDINGS=2
EN_CLIPS_DIR=./data/clips-en
EN_BUFFER_DIR=./data/buffer-en
EN_SHORTS_DIR=./data/shorts-en
EN_WATCHLIST_FILE=./data/watchlist-en.json
EN_SHORTS_OVERLAY_CONFIG=./config/shorts-overlays-en.json
EN_YT_CLIENT_SECRETS=./client_secrets-en.json
EN_YT_TOKEN_PATH=./token-en.json
EN_YT_PRIVACY=unlisted
EN_YT_UPLOAD=false
EN_YT_CATEGORY_ID=20
EN_YT_DEFAULT_TAGS=cs2,ace,5k,counter-strike,highlights
EN_YT_BRAND=...
EN_YT_DESC_CTA=...
EN_YT_QUOTA_UNITS_PER_DAY=10000
EN_SHORTS_ENABLED=true
EN_SHORTS_PRIVACY=unlisted
EN_SHORTS_CAPTIONS=false
EN_SHORTS_CAPTION_TRANSLATE=false
```

> `EN_YT_UPLOAD=false` é o estado da fase 2 (só grava). Na fase 3, ligar
> `EN_YT_UPLOAD=true` e `EN_SHORTS_ENABLED=true` juntos; o Short sai sem
> legenda (`EN_SHORTS_CAPTIONS=false`).

---

## Apêndice B — schema do banco

O schema **real** está em `src/db.ts` (`getDb` + funções de migração) —
não vale copiar para cá: ele muda. Para o estado atual:

```sql
-- src/db.ts (referência, 18/11/2026)
CREATE TABLE ace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL DEFAULT 'br',
  match_id TEXT NOT NULL,
  map TEXT NOT NULL,
  round INTEGER NOT NULL,
  player TEXT NOT NULL,
  team1 TEXT,
  team2 TEXT,
  event TEXT,
  detected_at TEXT NOT NULL,
  UNIQUE(channel_id, match_id, map, round, player)
);

CREATE TABLE clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ace_id INTEGER NOT NULL REFERENCES ace_events(id),
  channel_id TEXT NOT NULL DEFAULT 'br',
  file_path TEXT NOT NULL,
  youtube_video_id TEXT,
  privacy TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  format TEXT,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  is_shorts INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  published_at TEXT
);

CREATE UNIQUE INDEX idx_clips_ace_format
  ON clips (ace_id, COALESCE(format, ''));

CREATE TABLE discarded_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL DEFAULT 'br',
  match_id TEXT NOT NULL,
  map TEXT NOT NULL,
  round INTEGER NOT NULL,
  player TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  discarded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> `clips.channel_id` é derivado do ace (`ace_events.channel_id`) no
> `insertClip`: o clipe é sempre do canal do evento.

---

## Apêndice C — checklist de auditoria de copy (EN)

Procurar por texto pt-BR que possa vazar no canal EN:

- [ ] `src/clipper/copyRules.ts` — `fixMapPrepositions`/`mapWithArticle`
- [ ] `src/uploader/videoMetadata.ts` — `TITLE_TEMPLATES`,
      `buildTemplateDescription`, `buildFooter`, `sanitizeTitle`,
      `sanitizeDescription`, `buildShortTitle`, `composeDescription`
- [ ] `src/uploader/metadataAi.ts` — prompt, system prompt, chaves de
      `facts`
- [ ] `src/clipper/clipBuilder.ts` — `buildTitle`/`buildDescription`
      (legado)
- [ ] `src/clipper/shortOverlay.ts` — `resolveShortOverlayText`
- [ ] `src/clipper/shortCaptions.ts` — `translateCaptionLines`,
      review, `looksPortuguese`, `text_pt`
- [ ] `src/clipper/aiThumbnail.ts` — prompt (interno; conferir se o texto
      visível é só nome/evento/label)
- [ ] `src/uploader/youtubeUploader.ts` — prefixo "(replay do round ...)" e
      fallback `buildTitle`/`buildDescription`

**Teste de aceite:** gerar 20 metadados EN (AI + template) e falhar se
aparecer `\b(na|no|do|da)\s+(Dust2|Mirage|Inferno|Nuke|Ancient|Anubis|Vertigo|Overpass|Train)\b`
ou palavras pt-BR óbvias ("jogador", "kills" é ok em EN, "round" é ok).
