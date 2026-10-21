import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// A registered native command still fails at runtime unless the main window's
// capability grants it. Catch new frontend calls missing that second step.
it('grants every registered app command to the main window', () => {
  const native = join(process.cwd(), 'src-tauri');
  const capability = JSON.parse(readFileSync(join(native, 'capabilities/default.json'), 'utf8'));
  const permissions = readdirSync(join(native, 'permissions'))
    .filter(name => name.endsWith('.toml'))
    .flatMap(name => readFileSync(join(native, 'permissions', name), 'utf8').split('[[permission]]'))
    .filter(text => capability.permissions.includes(text.match(/identifier\s*=\s*"([^"]+)"/)?.[1]))
    .map(text => text.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '')
    .join('\n');
  const allowed = new Set([...permissions.matchAll(/"([a-z_]+)"/g)].map(m => m[1]));
  const main = readFileSync(join(native, 'src/main.rs'), 'utf8');
  const handler = main.split('tauri::generate_handler![')[1].split('])')[0];
  const commands = [...handler.matchAll(/(?:\b\w+::)*(\w+)\s*,/g)].map(m => m[1]);
  expect(commands.length).toBeGreaterThan(50);
  expect(commands.filter(command => !allowed.has(command))).toEqual([]);
});
