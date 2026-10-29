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
}

export interface KillEvent {
  killer: string;
  victim: string;
  round: number;
  map: string;
  /** Wall-clock (epoch ms) da detecção — ancora o início do clipe. */
  at?: number;
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
    /** Crop do placar que produziu a leitura. */
    crop?: string | null;
  };
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
  /** Placar no momento do ace, ex "6-3" (team1-team2). Opcional. */
  score?: string;
  /** Placar antes/depois do fechamento do round, ex "5-2" / "6-2". Opcional. */
  scoreBefore?: string;
  scoreAfter?: string;
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
}
