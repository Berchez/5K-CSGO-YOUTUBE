export interface StreamInfo {
  /** Nome exibido no HLTV (ex: "ESL_CS", "Gaules") */
  name: string;
  /** URL do embed/página (pode ser twitch url ou link HLTV) */
  url: string;
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
}

export interface KillEvent {
  killer: string;
  victim: string;
  round: number;
  map: string;
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
}

export interface ClipResult {
  filePath: string;
  sidecarPath: string;
  thumbnailPath?: string;
  durationSec: number;
}
