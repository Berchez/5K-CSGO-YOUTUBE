import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';

let logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (logger) return logger;
  const cfg = getConfig();
  const destDir = path.dirname(cfg.LOG_FILE);
  fs.mkdirSync(destDir, { recursive: true });

  logger = pino(
    { level: cfg.LOG_LEVEL },
    pino.multistream([
      { stream: process.stdout },
      {
        stream: pino.destination({
          dest: cfg.LOG_FILE,
          append: true,
          mkdir: true,
        }),
      },
    ]),
  );
  return logger;
}
