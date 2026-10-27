import { describe, expect, it } from 'vitest';
import { handleApi, isAllowedHost } from '../functions/_lib/handler';
import { MemoryMailer } from '../functions/_lib/mailer';
import { TEST_LOGIN_UNTIL, Service } from '../functions/_lib/service';
import { MemoryStore } from '../functions/_lib/store';

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(testLogin: { emails: Set<string>; code: string } | null = null, start = 86_400_000 * 20) {
  const clock = { now: start };
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const service = new Service(store, () => clock.now, mulberry(3), mailer, testLogin);
  return { clock, store, mailer, service };
}

const post = (service: Service, path: string, body: string, ip = '203.0.113.7', headers: Record<string, string> = {}) =>
  handleApi(new Request(`https://x/api/${path}`, { method: 'POST', body, headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers } }), service);

describe('Ratenbegrenzung', () => {
  it('höchstens 5 Code-Anfragen pro Minute und Adresse, 15 pro Tag', async () => {
    const { service, clock } = setup();
    const start = (i: number) => post(service, 'auth/start', `email nutzer${i}@example.com\nlang de\nend\n`);
    for (let i = 0; i < 5; i++) expect((await start(i)).status).toBe(200);
    expect((await start(5)).status).toBe(429);
    expect(await (await start(6)).text()).toBe('error ratelimit\n');
    // nächste Minute: wieder erlaubt, bis das Tageslimit von 15 erreicht ist
    let ok = 5;
    for (let minute = 0; minute < 6 && ok < 15; minute++) {
      clock.now += 61_000;
      for (let i = 0; i < 5 && ok < 15; i++) {
        expect((await start(100 + ok)).status).toBe(200);
        ok++;
      }
    }
    clock.now += 61_000;
    expect((await start(999)).status).toBe(429);
  });

  it('andere Adressen sind davon unberührt, ohne Adressangabe (Tests) gibt es keine Grenze', async () => {
    const { service } = setup();
    for (let i = 0; i < 5; i++) await post(service, 'auth/start', `email a${i}@example.com\nlang de\nend\n`, '198.51.100.1');
    expect((await post(service, 'auth/start', 'email b@example.com\nlang de\nend\n', '198.51.100.2')).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await post(service, 'auth/start', `email c${i}@example.com\nlang de\nend\n`, '')).status).toBe(200);
  });

  it('Code-Prüfung höchstens 10 pro Minute', async () => {
    const { service } = setup();
    const verify = () => post(service, 'auth/verify', 'email nutzer@example.com\ncode 123456\nend\n');
    for (let i = 0; i < 10; i++) expect((await verify()).status).toBe(200);
    expect((await verify()).status).toBe(429);
  });

  it('Beitritte per Code höchstens 10 pro Minute und Konto', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const join = () => post(service, 'games/join', 'ABCDEF', '203.0.113.9', { 'X-Account': a.id, 'X-Secret': a.secret });
    for (let i = 0; i < 10; i++) expect((await join()).status).toBe(200);
    expect((await join()).status).toBe(429);
  });
});

describe('Testzugang läuft ab', () => {
  it('nach dem Stichtag gilt der feste Code nicht mehr, es wird eine echte Mail geschickt', async () => {
    const testLogin = { emails: new Set(['test1@rummy-test.invalid']), code: '424242' };
    const before = setup(testLogin, TEST_LOGIN_UNTIL - 86_400_000);
    await before.service.startAuth('test1@rummy-test.invalid', 'login', 'de');
    expect(before.mailer.sent).toHaveLength(0);
    expect((await before.service.verifyAuth('test1@rummy-test.invalid', '424242', 'login')).account).toBeDefined();

    const after = setup(testLogin, TEST_LOGIN_UNTIL + 1000);
    await after.service.startAuth('test1@rummy-test.invalid', 'login', 'de');
    expect(after.mailer.sent).toHaveLength(1);
    expect((await after.service.verifyAuth('test1@rummy-test.invalid', '424242', 'login')).error).toBe('code');
  });

  it('die Wartung entfernt Testkonten, sobald der Zugang nicht mehr gilt', async () => {
    const testLogin = { emails: new Set(['test1@rummy-test.invalid']), code: '424242' };
    const { service, store, clock } = setup(testLogin, TEST_LOGIN_UNTIL - 86_400_000);
    await service.startAuth('test1@rummy-test.invalid', 'login', 'de');
    const id = (await service.verifyAuth('test1@rummy-test.invalid', '424242', 'login')).account!.id;
    await service.maintenance();
    expect(await store.getAccount(id)).not.toBeNull();
    clock.now = TEST_LOGIN_UNTIL + 1000;
    await service.maintenance();
    expect(await store.getAccount(id)).toBeNull();
  });
});

describe('Erlaubte Hostnamen', () => {
  it('nur die eigene Adresse, lokale Entwicklung und eigene Zusätze', () => {
    expect(isAllowedHost('rummy-game-6ke.pages.dev')).toBe(true);
    expect(isAllowedHost('localhost:8788')).toBe(true);
    expect(isAllowedHost('e4c6a7b4.rummy-game-6ke.pages.dev')).toBe(false);
    expect(isAllowedHost('main.rummy-game-6ke.pages.dev')).toBe(false);
    expect(isAllowedHost('evil.example.com')).toBe(false);
    expect(isAllowedHost('rummy.example.org', 'rummy.example.org, other.example')).toBe(true);
  });
});

describe('Brevo-Zugangsdaten aus Secrets', () => {
  it('lösen Schlüssel und Adresse aus Fremdzeichen heraus', async () => {
    const { BrevoMailer } = await import('../functions/_lib/mailer');
    const seen: Array<Record<string, unknown>> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    try {
      const mailer = new BrevoMailer('﻿?xkeysib-abc123-DEF456\r\n', '﻿fsnavivfr@gmail.com\r\n', 'Rummy\r\n');
      expect(await mailer.send('a@example.com', 'Betreff', 'Text')).toBe(true);
      expect((seen[0].headers as Record<string, string>)['api-key']).toBe('xkeysib-abc123-DEF456');
      expect((seen[0].body as { sender: { email: string; name: string } }).sender).toEqual({ email: 'fsnavivfr@gmail.com', name: 'Rummy' });
    } finally {
      globalThis.fetch = original;
    }
  });
});
