export interface StreamInfo {
  /** Nome exibido no HLTV (ex: "ESL_CS", "Gaules") */
  name: string;
  /** URL do embed/página (pode ser twitch url ou link HLTV) */
  url: string;
  country?: string;
  language?: string;
  viewers?: number;
  /** true se parece stream oficial do evento (ESL, BLAST, PGL, StarLadder...) */
  isOfficialGuess?: boolean;
}

export interface LiveMatch {
  matchId: string;
  team1: string;
  team2: string;
  event: string;
  stars: number;
  isTopTierGuess: boolean;
  matchPageUrl: string;
  streams: StreamInfo[];
  /** Limiar efetivo de kills (watchlist vence a política por estrelas). */
  minKills?: number;
  /** Times da watchlist que casaram com a partida. */
  watchlistedTeams?: string[];
  /** true quando entrou pelo override da watchlist (mesmo com 0-1★). */
  watchlisted?: boolean;
  /** Rank HLTV dos times no momento da entrada (null/ausente = sem rank). */
  team1Rank?: number;
  team2Rank?: number;
  /**
   * A condição de rank foi ATENDIDA para esta partida (conforme
   * `RANK_STARS_MODE`, sempre independente do `MIN_STARS`): o limiar
   * `RANK_MIN_KILLS` vale para os times liberados.
   */
  rankQualified?: boolean;
  /**
   * A partida entrou SÓ pela regra de rank (não passou em estrelas nem na
   * watchlist): só os times liberados geram clipe.
   */
  rankOnly?: boolean;
  /** Times (nomes do listing) liberados pela regra de rank. */
  rankAllowedTeams?: string[];
}

export interface KillEvent {
  killer: string;
  victim: string;
  round: number;
  map: string;
  /** Wall-clock (epoch ms) da detecção — ancora o início do clipe. */
  at?: number;
  /** Posicao da kill na timeline do VOD (segundos); so scripts de VOD usam. */
  atVodSec?: number;
  /** Origem do timestamp (`placar`, `killfeed`, `vod`...). */
  atSource?: string;
  /** A kill foi vista no replay (posicao estimada, nao ao vivo). */
  appearEstimated?: boolean;
  /**
   * A posição da kill foi ESTIMADA (não medida no vídeo): a descrição
   * não pode afirmar um horário que ninguém mediu — e o Short não pode
   * montar a janela em cima dela.
   *
   * Ocorrências: o teto de abertura limitou a latência estimada (a
   * posição vem do palpite, não de uma medição) ou a kill foi lida no
   * placar sem âncora no vídeo.
   */
  estimated?: boolean;
  /** Arma do kill: ak47, awp, deagle, hegrenade, molotov, knife... (minúsculo; '' = desconhecida) */
  weapon?: string;
  headshot?: boolean;
  /** Quem deu assistência no kill (dano prévio). */
  assistBy?: string;
  /** Quem cegou a vítima com flash antes do kill. */
  flashAssistBy?: string;
  throughSmoke?: boolean;
  wallbang?: boolean;
  noscope?: boolean;
}

/** Uso de granada no round (nem todo uso vira kill — dano/cegueira contam). */
export interface GrenadeUse {
  player: string;
  kind: 'he' | 'flash' | 'smoke' | 'molotov' | 'inc';
  /** Dano causado (HE/molotov) ou nº de inimigos cegados (flash). */
  value?: number;
}

/**
 * Confiança na âncora de início do clipe (a "1ª kill" do destaque).
 * Qualquer sinal ligado = a kill pode não ser a 1ª real do round.
 */
export interface AnchorConfidence {
  /** Tracker começou/retomou no meio do round (kills anteriores invisíveis). */
  joinedMidRound: boolean;
  /** Base reancorada (gap) durante este round. */
  resetThisRound: boolean;
  /** Kills do evento observadas na janela de assentamento entre rounds. */
  settleKills: number;
}

/**
 * Telemetria do pareamento entre o placar e o killfeed do scorebot.
 *
 * O placar do DOM só conta K/D: arma, headshot e assistência vêm do
 * scorebot. Esta contagem diz quanto do round foi de fato completado —
 * sem ela, uma kill sem par (nome divergente, feed atrasado) só aparece
 * como `null` no sidecar, meses depois.
 */
export interface KillfeedTelemetry {
  /** Kills do placar que receberam o detalhe do killfeed. */
  paired: number;
  /** Total de kills do round (todos os jogadores — o mesmo universo de `paired`). */
  total: number;
  /** Kills do killfeed que chegaram para este round. */
  feedKills: number;
  /** `eventId`s do scorebot que entraram no round (depuração). */
  eventIds: string[];
  /**
   * Kills do feed cujo round NÃO bateu com o round do placar.
   *
   * O round do feed é contado pelos `RoundStart` do scorebot e o do
   * placar é `ct+t+1`: quando os dois divergem (reconexão, restart de
   * round, OT), a kill não pareia — ou fica na fila esperando o round
   * seguinte. Sem este contador, o detalhe que faltou na kill parecia
   * um bug do killfeed.
   */
  roundDrift?: number;
}

/** Resumo completo do round do ace — alimenta título, descrição, thumb e prompt IA. */
export interface RoundSummary {
  round: number;
  map: string;
  player: string;
  team: string;
  opponents: string;
  kills: KillEvent[];
  victims: string[];
  /** Armas na ordem dos kills, ex: ['ak47','ak47','awp','hegrenade','ak47'] */
  weapons: string[];
  headshots: number;
  /**
   * `false` quando nenhuma kill trouxe a informacao de headshot: o valor
   * em `headshots` e 0 por ausencia, nao porque o placar mediu 0. Sidecars
   * v2 gravam `stats.headshots = null` nesse caso.
   */
  headshotsKnown?: boolean;
  assists: Array<{ by: string; killIndex: number }>;
  flashAssists: Array<{ by: string; killIndex: number }>;
  grenades: GrenadeUse[];
  /** Arma mais usada (para título/thumb/prompt). '' se desconhecida. */
  mainWeapon: string;
}

export interface AceEvent {
  matchId: string;
  map: string;
  round: number;
  player: string;
  team1: string;
  team2: string;
  event: string;
  /** URL da partida na HLTV (fonte canônica do confronto). */
  matchUrl?: string;
  detectedAt: string;
  kills: KillEvent[];
  /** ISO do 1º kill da sequência — o clipe começa ~10s antes dele. */
  startedAt?: string;
  /** ISO do fim do clipe (placar do round + CLIP_END_AFTER_CLOSE_SEC). */
  endedAt?: string;
  /**
   * ISO do FIM REAL do round no relógio do jogo (o placar do HLTV
   * mostrou "Round over"). Ausente = o placar não expõe o timer e a
   * estimativa (detecção − atraso do placar) vale.
   */
  roundEndedAt?: string;
  /** Calibração do fim do clipe pelo placar do round no vídeo. */
  streamSync?: {
    mode: 'auto' | 'log' | 'off';
    applied: boolean;
    source?: 'scoreboard' | 'killfeed';
    marker?: 'score' | 'round' | null;
    offsetMs: number | null;
    matchedKills: number;
    totalKills: number;
    medianDeviationMs: number | null;
    reason: string;
    roundEndAt?: string | null;
    scoreBefore?: string | null;
    scoreAfter?: string | null;
    /** Latência observada no round (ms): vídeo − relógio do jogo. */
    observedLatencyMs?: number | null;
    /** Latência (ms) que ancorou o INÍCIO do clipe. */
    startLatencyMs?: number | null;
    /** Latência (ms) que ancorou o FIM estimado (sem âncora do OCR). */
    endLatencyMs?: number | null;
    /** De onde veio a latência do início (config/prior/current/min-safe). */
    latencySource?: string | null;
    /** O round trocou de regime de latência (início incerto). */
    latencyChanged?: boolean;
    /**
     * O teto de CLIP_START_LATENCY_MAX_MS limitou a latência de ABERTURA
     * (o corte abriu mais cedo que a estimativa). Os timestamps e a
     * cobertura continuam com a estimativa — só a abertura mudou.
     */
    startLatencyCapped?: boolean;
    /**
     * A latência ESTIMADA do início (ms) — o valor que o teto limitou.
     * Com o teto ativo, é a melhor estimativa disponível (pode estar
     * inflada): por isso as kills saem marcadas como `estimated` e a
     * descrição não afirma horários.
     */
    estimatedStartLatencyMs?: number | null;
    /** Crop do placar que produziu a leitura. */
    crop?: string | null;
    /**
     * De onde veio a ÂNCORA que abriu o clipe: 'placar', 'killfeed'
     * (medição confirmada) ou 'killfeed+placar' (o menor dos dois).
     */
    anchorSource?: 'placar' | 'killfeed' | 'killfeed+placar' | null;
    /**
     * Âncora do killfeed: o instante no VÍDEO da 1ª kill lida no
     * killfeed (ms). Com o motivo (`killfeedReason`), é a evidência
     * que diz se a janela foi aberta por uma leitura ao vivo ou pela
     * reexibição do replay.
     */
    killfeedFirstKillVideoMs?: number | null;
    /** Motivo da medição do killfeed (confident/first-kill-only/...). */
    killfeedReason?: string | null;
    /** Crop do killfeed que produziu a leitura. */
    killfeedCrop?: string | null;
    /**
     * Leituras do killfeed descartadas por serem REEXIBIÇÃO (o banner
     * "REPLAY" na tela): elas provam que o round já tinha acabado
     * quando a âncora foi lida.
     */
    killfeedReplayReads?: number | null;
  };
  /**
   * Dispersão entre a 1ª e a última kill do ace (ms). Acima do limite a
   * lista de kills mistura rounds (o `at` do HLTV é o instante do poll,
   * que atrasa 5..16s por kill) e o clipe atravessa a partida.
   */
  killsSpreadMs?: number | null;
  /**
   * Auditoria da JANELA depois de renderizar (diagnóstico + guardrail):
   * as invariantes conferidas e a ação decidida (publicar, descartar
   * ou publicar marcado como replay).
   */
  clipWindowAudit?: {
    action?: 'ok' | 'discard' | 'replay-only';
    violations?: string[];
    reason?: string;
    coversFirstKill?: boolean | null;
    coversLastKill?: boolean | null;
    startsAfterRoundEnd?: boolean | null;
    liveMaterialAvailable?: boolean | null;
  } | null;
  /**
   * A janela do clipe contém quebra de continuidade da timeline da
   * fonte (descontinuidade de PTS/salto/stall): o material pode ter um
   * buraco — o clipe é sinalizado, não entregue em silêncio.
   */
  timelineDiscontinuity?: boolean;
  /**
   * Confiança na âncora de início: a "1ª kill" é a primeira OBSERVADA pelo
   * tracker — se ele entrou no meio do round, resetou a base ou a kill veio
   * da janela de assentamento entre rounds, pode não ser a 1ª kill real.
   */
  anchorConfidence?: AnchorConfidence;
  /**
   * A âncora de início é mais velha que o buffer (abertura real fora do
   * alcance): o clipe começa no material mais antigo disponível — abertura
   * sabidamente incompleta, nunca silenciosa.
   */
  truncatedStart?: boolean;
  /**
   * Offset (ms) que converte o relogio do placar (`kill.at`) para o relogio
   * do video: `at + killVideoOffsetMs` = instante da kill no video. No
   * sidecar v2 vive em `sync.killVideoOffsetMs`.
   */
  killVideoOffsetMs?: number | null;
  /** Placar no momento do ace, ex "6-3" (team1-team2). Opcional. */
  score?: string;
  /** Placar antes/depois do fechamento do round, ex "5-2" / "6-2". Opcional. */
  scoreBefore?: string;
  scoreAfter?: string;
  /** Time que venceu o round, quando o placar permite derivar com segurança. */
  roundWinner?: string;
  /**
   * Início REAL do clipe (epoch ms) — gravado no sidecar pelo clipBuilder.
   * Difere da estimativa (1ª kill − contexto) quando a abertura foi
   * truncada pelo buffer.
   */
  clipStartMs?: number;
  /** Duração real do clipe (s) — gravada no sidecar pelo clipBuilder. */
  clipDurationSec?: number;
  /** Resumo rico (armas, vítimas, assists, granadas). Ausente em modos sem detalhe (ex: VOD). */
  summary?: RoundSummary;
  /**
   * Telemetria do pareamento com o killfeed do scorebot (arma/headshot/
   * assistência). Grava no sidecar quanto do round foi completado — é o
   * que revela uma kill sem par (feed atrasado, nome divergente).
   */
  killfeed?: KillfeedTelemetry | null;
}

export interface ClipResult {
  filePath: string;
  sidecarPath: string;
  thumbnailPath?: string;
  durationSec: number;
  /** Início real do clipe (epoch ms) — âncora dos timestamps da descrição. */
  clipStartMs?: number;
  /** Duração real do clipe (s), medida no arquivo final. */
  clipDurationSec?: number;
  /**
   * Início do material mais antigo disponível no buffer (epoch ms): se
   * for DEPOIS do round, o clipe só pode mostrar a reexibição dele.
   */
  bufferOldestMs?: number | null;
  /** De onde veio a âncora que abriu o clipe (placar/killfeed/...). */
  anchorSource?: 'placar' | 'killfeed' | 'killfeed+placar' | null;
}
