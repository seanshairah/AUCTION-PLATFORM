import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Loads KEY=value lines from the repository's untracked .env into process.env,
 * without overriding variables already set. Secrets (DATABASE_URL) live there
 * locally and in the secrets manager elsewhere, never in the repository.
 */
export function loadDotEnv(file = `${ROOT}.env`): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
}
