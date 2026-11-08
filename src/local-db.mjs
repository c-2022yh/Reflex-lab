import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  // Allow the previous and candidate containers to overlap during deployment.
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec(readFileSync(join(root, 'migrations/0001_initial.sql'), 'utf8'));
  const prepare = (sql, values = []) => ({
    bind: (...next) => prepare(sql, next),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) {
          try { results.push(await statement.all()); }
          catch { results.push(await statement.run()); }
        }
        sqlite.exec('COMMIT'); return results;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
    close: () => sqlite.close(),
  };
}
