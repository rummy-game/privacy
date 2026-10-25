import { describe, expect, it } from 'vitest';
import { defaultRules } from '../functions/_lib/rules';
import { FINISHED_KEEP_MS, LOBBY_KEEP_MS, Service } from '../functions/_lib/service';
import { MemoryStore } from '../functions/_lib/store';
import { handleApi } from '../functions/_lib/handler';

describe('Aufräumen', () => {
  it('löscht alte beendete und nie gestartete Partien, behält laufende', async () => {
    const clock = { now: 1_000_000 };
    const store = new MemoryStore();
    let n = 0;
    const service = new Service(store, () => clock.now, () => ((n = (n * 9301 + 49297) % 233280), n / 233280));
    const a = (await service.createAccount())!;
    const lobby = (await service.createGame(a.id, { seats: 2, rules: defaultRules(), fillLevel: 'BEGINNER', limitSeconds: 3600 })).view!;
    const running = (await service.createGame(a.id, { seats: 2, rules: defaultRules(), fillLevel: 'BEGINNER', limitSeconds: 10 * 24 * 3600 })).view!;
    await service.start(a.id, running.id);
    clock.now += LOBBY_KEEP_MS + 1000;
    await service.maintenance();
    expect(await store.loadGame(lobby.id)).toBeNull();
    expect(await store.loadGame(running.id)).not.toBeNull();
    // beendete Partie
    const done = (await service.createGame(a.id, { seats: 2, rules: { ...defaultRules(), handSize: 7, initialMeldMin: 0 }, fillLevel: 'BEGINNER', limitSeconds: 3600 })).view!;
    let v = (await service.start(a.id, done.id)).view!;
    for (let i = 0; v.status === 'RUNNING' && i < 500; i++) v = (await service.move(a.id, done.id, { turn: v.turn, table: null })).view!;
    expect(v.status).toBe('FINISHED');
    clock.now += FINISHED_KEEP_MS + 1000;
    await service.maintenance();
    expect(await store.loadGame(done.id)).toBeNull();
  });

  it('der Wartungsaufruf braucht das Geheimnis', async () => {
    const service = new Service(new MemoryStore(), Date.now, Math.random);
    const call = (token?: string) =>
      handleApi(new Request('https://x.test/api/maintenance', { method: 'POST', body: '', headers: token ? { 'X-Maintenance': token } : {} }), service, 'geheim');
    expect((await call()).status).toBe(401);
    expect((await call('falsch')).status).toBe(401);
    expect((await call('geheim')).status).toBe(200);
    const none = await handleApi(new Request('https://x.test/api/maintenance', { method: 'POST', body: '' }), service, '');
    expect(none.status).toBe(401);
  });
});
