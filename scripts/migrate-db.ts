/**
 * Migração do banco para multi-canal (`channel_id`).
 *
 * O bot aplica a migração sozinho no boot (`getDb`) e tira backup antes
 * do rebuild. Este script serve para INSPECIONAR antes e deixar um
 * backup explícito:
 *
 *   npx tsx scripts/migrate-db.ts            # dry-run (não escreve nada)
 *   npx tsx scripts/migrate-db.ts --apply    # backup + migra + confere
 *   npx tsx scripts/migrate-db.ts --db <arquivo>
 *
 * Pare o bot antes do `--apply`: a migração reconstrói `ace_events` e o
 * rebuild precisa do arquivo livre.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getConfig } from '../src/config.js';
import { closeDb, getDb } from '../src/db.js';

interface Args {
  apply: boolean;
  db?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--db') out.db = argv[++i];
    else if (arg.startsWith('--db=')) out.db = arg.slice('--db='.length);
  }
  return out;
}

interface TableInfo {
  columns: string[];
  rows: number;
}

function inspectTable(db: Database.Database, table: string): TableInfo {
  const columns = (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const rows =
    columns.length > 0
      ? Number(
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined)?.n ??
            0,
        )
      : 0;
  return { columns, rows };
}


function inspect(file: string): {
  ace: TableInfo;
  clips: TableInfo;
  discarded: TableInfo;
} {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      ace: inspectTable(db, 'ace_events'),
      clips: inspectTable(db, 'clips'),
      discarded: inspectTable(db, 'discarded_events'),
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const file = args.db ?? getConfig().DB_PATH;
  if (!fs.existsSync(file)) {
    console.error(`Banco não encontrado: ${file}`);
    process.exitCode = 1;
    return;
  }

  const before = inspect(file);
  const rebuild = !before.ace.columns.includes('channel_id');
  const addClips = !before.clips.columns.includes('channel_id');
  const addDiscarded = !before.discarded.columns.includes('channel_id');

  console.log(`Banco: ${file}`);
  console.log(
    `ace_events: ${rebuild ? 'REBUILD (UNIQUE por canal)' : 'ok'} — ${before.ace.rows} linha(s)`,
  );
  console.log(
    `clips: ${addClips ? 'ADD COLUMN channel_id' : 'ok'} — ${before.clips.rows} linha(s)`,
  );
  console.log(
    `discarded_events: ${addDiscarded ? 'ADD COLUMN channel_id' : 'ok'} — ${before.discarded.rows} linha(s)`,
  );

  if (!rebuild && !addClips && !addDiscarded) {
    console.log('Nada a migrar.');
    return;
  }
  if (!args.apply) {
    console.log('\nDry-run: nada foi alterado.');
    console.log('Pare o bot e rode de novo com --apply (o script faz backup antes).');
    return;
  }

  // getDb() executa a migração e cria o backup .pre-channel.bak automaticamente
  // antes do rebuild de ace_events via VACUUM INTO.
  console.log('Aplicando migração...');
  getDb(file);
  closeDb();

  const backupFile = `${file}.pre-channel.bak`;
  if (fs.existsSync(backupFile)) {
    console.log(`Backup: ${backupFile}`);
  }

  // Conferência pós-migração: as contagens não podem ter mudado e as
  // referências de `clips.ace_id` precisam continuar válidas.
  const after = inspect(file);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let channels: Array<{ channel_id: string; n: number }>;
  let fkViolations: number;
  let orphans: number;
  try {
    channels = db
      .prepare('SELECT channel_id, COUNT(*) AS n FROM ace_events GROUP BY channel_id')
      .all() as Array<{ channel_id: string; n: number }>;
    fkViolations = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    orphans = Number(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM clips c LEFT JOIN ace_events e ON e.id=c.ace_id WHERE e.id IS NULL',
          )
          .get() as { n: number }
      ).n,
    );
  } finally {
    db.close();
  }
  console.log('\nDepois da migração:');
  console.log(
    `ace_events: ${after.ace.rows} linha(s) — canal: ${channels.map((c) => `${c.channel_id}=${c.n}`).join(', ') || '(vazio)'}`,
  );
  console.log(`clips: ${after.clips.rows} linha(s)`);
  console.log(`discarded_events: ${after.discarded.rows} linha(s)`);
  console.log(`clipes órfãos: ${orphans}`);
  console.log(`violações de foreign key: ${fkViolations}`);
  const ok =
    after.ace.rows === before.ace.rows &&
    after.clips.rows === before.clips.rows &&
    after.discarded.rows === before.discarded.rows &&
    fkViolations === 0 &&
    orphans === 0;
  console.log(ok ? '\nMigração OK (contagens e referências intactas).' : '\nATENÇÃO: confira o banco.');
  if (!ok) process.exitCode = 1;
}

main();
