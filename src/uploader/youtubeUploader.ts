import fs from 'node:fs';
import { google } from 'googleapis';
import type { AceEvent } from '../types.js';
import { buildDescription, buildTitle } from '../clipper/clipBuilder.js';
import { getLogger } from '../logger.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

export function loadOAuthClient(
  clientSecretsPath: string,
  tokenPath: string,
) {
  if (!fs.existsSync(clientSecretsPath)) {
    throw new Error(
      `client_secrets.json não encontrado em ${clientSecretsPath}. Crie no Google Cloud Console (OAuth Client Desktop) e rode: npm run auth:youtube`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(clientSecretsPath, 'utf8'));
  const creds = raw.web ?? raw.installed;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  if (fs.existsSync(tokenPath)) {
    oauth.setCredentials(JSON.parse(fs.readFileSync(tokenPath, 'utf8')));
  }
  return oauth;
}

export function getAuthUrl(clientSecretsPath: string): string {
  const raw = JSON.parse(fs.readFileSync(clientSecretsPath, 'utf8'));
  const creds = raw.web ?? raw.installed;
  const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'urn:ietf:wg:oauth:2.0:oob');
  // select_account: força a tela de escolha de conta E de canal (conta de marca).
  // Quem tem vários canais (berchez + cliponera) precisa escolher cliponera aqui —
  // o token fica amarrado ao canal escolhido.
  return oauth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent select_account' });
}

export async function saveTokenFromCode(
  clientSecretsPath: string,
  tokenPath: string,
  code: string,
): Promise<void> {
  const oauth = loadOAuthClient(clientSecretsPath, tokenPath);
  const { tokens } = await oauth.getToken(code.trim());
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
}

export interface UploadOptions {
  clientSecretsPath: string;
  tokenPath: string;
  privacy: 'private' | 'unlisted' | 'public';
  categoryId: string;
  defaultTags: string;
  /** Caminho da thumb 1280x720 (opcional). Sobe via thumbnails.set após o vídeo. */
  thumbnailPath?: string;
}

/**
 * Upload sempre como private no MVP (revisão humana no YouTube Studio).
 * Quota: videos.insert tem bucket próprio (~100/dia). Projetos novos precisam
 * de auditoria para vídeos públicos — por isso private primeiro.
 */
export async function uploadClip(
  ace: AceEvent,
  filePath: string,
  opts: UploadOptions,
): Promise<string> {
  const log = getLogger();
  const auth = loadOAuthClient(opts.clientSecretsPath, opts.tokenPath);
  const youtube = google.youtube({ version: 'v3', auth });

  const title = buildTitle(ace).slice(0, 100);
  const description = buildDescription(ace, opts.defaultTags);
  const tags = [...new Set([...opts.defaultTags.split(',').map((t) => t.trim()).filter(Boolean), ace.player, ace.map, ace.event])].slice(0, 30);

  log.info({ title, privacy: opts.privacy }, 'enviando para o YouTube');
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, tags, categoryId: opts.categoryId },
      status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  const videoId = res.data.id ?? '';
  if (!videoId) throw new Error('YouTube não retornou videoId');
  log.info({ videoId }, 'upload concluído (privado, aguardando revisão)');

  if (opts.thumbnailPath && fs.existsSync(opts.thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: 'image/jpeg',
          body: fs.createReadStream(opts.thumbnailPath),
        },
      });
      log.info({ videoId }, 'thumbnail aplicada');
    } catch (e) {
      // Thumb é cosmético: não falha o pipeline (custo 50u de quota, pode estourar antes do upload)
      log.warn({ err: String(e).slice(0, 200) }, 'falha ao aplicar thumbnail, vídeo segue sem ela');
    }
  }
  return videoId;
}
