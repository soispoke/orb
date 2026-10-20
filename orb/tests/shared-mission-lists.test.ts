import {afterEach, expect, it, vi} from 'vitest';
import {listMissions, renameMission, setConnection} from '../src/api';

afterEach(() => vi.unstubAllGlobals());

it('shares one in-flight list read, gives each caller its own copy, and never joins a read after a write', async () => {
  setConnection('http://core.test', 'token');
  const lists: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') lists.push(url);
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Response(JSON.stringify(init?.method === 'POST' ? {} : [{id: 'a', title: 'A', status: 'completed', project: 'p'}]), {status: 200, headers: {'Content-Type': 'application/json'}});
  }));
  const [first, second] = await Promise.all([listMissions(), listMissions()]);
  expect(lists.filter(url => url.includes('/api/control/missions?limit=200'))).toHaveLength(1);
  expect(first).toEqual(second);
  expect(first[0]).not.toBe(second[0]);
  const before = listMissions();
  await renameMission('a', 'B');
  await Promise.all([before, listMissions()]);
  expect(lists.filter(url => url.includes('/api/control/missions?limit=200'))).toHaveLength(3);
});
