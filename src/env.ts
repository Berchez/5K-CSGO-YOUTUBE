import fs from 'node:fs';
import dotenv from 'dotenv';
import { repoPath } from './paths.js';

const envFile = repoPath('.env');

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile, override: true });
} else {
  dotenv.config({ override: true });
}
