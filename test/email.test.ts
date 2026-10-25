import { describe, expect, it } from 'vitest';
import { handleApi } from '../functions/_lib/handler';
import { MemoryMailer, NoMailer } from '../functions/_lib/mailer';
import { CODE_TTL_MS, MAX_CODE_ATTEMPTS, MAX_MAILS_PER_DAY, normalizeEmail, Service } from '../functions/_lib/service';
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

function setup(mailer = new MemoryMailer()) {
  const clock = { now: 86_400_000 * 20 };
  const store = new MemoryStore();
  const service = new Service(store, () => clock.now, mulberry(5), mailer);
  return { clock, store, service, mailer };
}

describe('E-Mail-Anmeldung', () => {
  it('normalisiert und prüft Adressen', () => {
    expect(normalizeEmail('  Anna@Example.COM ')).toBe('anna@example.com');
    for (const bad of ['', 'anna', 'anna@', '@example.com', 'a b@example.com', 'anna@example', 'anna@@example.com', 'a<b>@example.com']) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    expect(normalizeEmail('x'.repeat(250) + '@example.com')).toBeNull();
  });

  it('Code per Mail, Bestätigung legt das Konto an', async () => {
    const { service, mailer } = setup();
    expect((await service.startAuth('Anna@example.com', 'login', 'de')).error).toBeNull();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('anna@example.com');
    expect(mailer.sent[0].text).toContain('Rummy');
    const code = mailer.lastCode()!;
    expect(code).toMatch(/^\d{6}$/);

    const r = await service.verifyAuth('anna@example.com', code, 'login');
    expect(r.error).toBeNull();
    expect(r.account!.isNew).toBe(true);
    expect(r.account!.name).toMatch(/^[A-Za-zÄÖÜäöüß]+-[A-Za-z]+-\d{3}$/);
    expect(await service.authenticate(r.account!.id, r.account!.secret)).toBe(true);
    // Der Code ist verbraucht.
    expect((await service.verifyAuth('anna@example.com', code, 'login')).error).toBe('code');
  });

  it('zweites Gerät: gleiches Konto, neuer Schlüssel, der alte bleibt gültig', async () => {
    const { service, mailer, clock } = setup();
    await service.startAuth('b@example.com', 'login', 'en');
    const first = (await service.verifyAuth('b@example.com', mailer.lastCode()!, 'login')).account!;
    clock.now += 60_000;
    await service.startAuth('B@example.com', 'login', 'en');
    expect(mailer.sent[1].text).toContain('confirmation code');
    const second = (await service.verifyAuth('b@example.com', mailer.lastCode()!, 'login')).account!;
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(second.secret).not.toBe(first.secret);
    expect(await service.authenticate(first.id, first.secret)).toBe(true);
    expect(await service.authenticate(second.id, second.secret)).toBe(true);
    expect(await service.authenticate(first.id, 'falsch')).toBe(false);
  });

  it('falscher Code zählt, nach fünf Fehlversuchen ist gesperrt, auch der richtige Code geht dann nicht', async () => {
    const { service, mailer } = setup();
    await service.startAuth('c@example.com', 'login', 'de');
    const right = mailer.lastCode()!;
    const wrong = right === '123456' ? '654321' : '123456';
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) expect((await service.verifyAuth('c@example.com', wrong, 'login')).error).toBe('code');
    expect((await service.verifyAuth('c@example.com', wrong, 'login')).error).toBe('locked');
    expect((await service.verifyAuth('c@example.com', right, 'login')).error).toBe('locked');
  });

  it('der Code läuft nach 15 Minuten ab', async () => {
    const { service, mailer, clock } = setup();
    await service.startAuth('d@example.com', 'login', 'de');
    const code = mailer.lastCode()!;
    clock.now += CODE_TTL_MS + 1000;
    expect((await service.verifyAuth('d@example.com', code, 'login')).error).toBe('code');
  });

  it('begrenzt das Nachsenden: 30 Sekunden Pause, fünf Codes pro Stunde', async () => {
    const { service, clock, mailer } = setup();
    expect((await service.startAuth('e@example.com', 'login', 'de')).error).toBeNull();
    expect((await service.startAuth('e@example.com', 'login', 'de')).error).toBe('throttled');
    for (let i = 1; i < 5; i++) {
      clock.now += 31_000;
      expect((await service.startAuth('e@example.com', 'login', 'de')).error, `Versand ${i + 1}`).toBeNull();
    }
    clock.now += 31_000;
    expect((await service.startAuth('e@example.com', 'login', 'de')).error).toBe('throttled');
    expect(mailer.sent).toHaveLength(5);
    clock.now += 3_600_000;
    expect((await service.startAuth('e@example.com', 'login', 'de')).error).toBeNull();
  });

  it('Tageslimit für Mails schützt den Anbieter', async () => {
    const { service, clock, mailer, store } = setup();
    const day = Math.floor(clock.now / 86_400_000);
    for (let i = 0; i < MAX_MAILS_PER_DAY; i++) await store.countMail(day);
    expect((await service.startAuth('f@example.com', 'login', 'de')).error).toBe('busy');
    expect(mailer.sent).toHaveLength(0);
  });

  it('ungültige Adresse und Versandfehler', async () => {
    const { service } = setup();
    expect((await service.startAuth('kaputt', 'login', 'de')).error).toBe('invalid-email');
    const none = setup(undefined as never);
    void none;
    const failing = new Service(new MemoryStore(), Date.now, mulberry(1), new NoMailer());
    expect((await failing.startAuth('g@example.com', 'login', 'de')).error).toBe('mail');
    // Nach einem Fehlversand bleibt kein halber Code zurück.
    expect((await failing.verifyAuth('g@example.com', '123456', 'login')).error).toBe('code');
  });

  it('Löschen per Code: Konto samt Schlüsseln und E-Mail verschwindet, ohne Konto wird keine Mail gesendet', async () => {
    const { service, mailer, store, clock } = setup();
    expect((await service.startAuth('h@example.com', 'delete', 'de')).error).toBeNull(); // kein Konto: still
    expect(mailer.sent).toHaveLength(0);

    await service.startAuth('h@example.com', 'login', 'de');
    const acc = (await service.verifyAuth('h@example.com', mailer.lastCode()!, 'login')).account!;
    clock.now += 60_000;
    await service.startAuth('h@example.com', 'delete', 'de');
    expect(mailer.sent[1].text).toContain('Löschen');
    // Ein Anmelde-Code löscht nichts.
    expect((await service.verifyAuth('h@example.com', mailer.lastCode()!, 'login')).error).toBe('code');
    expect((await service.verifyAuth('h@example.com', mailer.lastCode()!, 'delete')).error).toBeNull();
    expect(await service.authenticate(acc.id, acc.secret)).toBe(false);
    expect(await store.findAccountByEmail('h@example.com')).toBeNull();
    expect(store.secrets.has(acc.id)).toBe(false);
  });

  it('Testadressen: fester Code ohne Mail, alle anderen Adressen bleiben beim Mailversand', async () => {
    const mailer = new MemoryMailer();
    const service = new Service(new MemoryStore(), () => 1_000_000, mulberry(2), mailer, { emails: new Set(['test1@rummy-test.invalid']), code: '424242' });
    expect((await service.startAuth('Test1@rummy-test.invalid', 'login', 'de')).error).toBeNull();
    expect(mailer.sent).toHaveLength(0);
    expect((await service.verifyAuth('test1@rummy-test.invalid', '111111', 'login')).error).toBe('code');
    const ok = await service.verifyAuth('test1@rummy-test.invalid', '424242', 'login');
    expect(ok.account?.isNew).toBe(true);
    // Andere Adresse mit dem Testcode: kein Code vorhanden.
    expect((await service.verifyAuth('anna@example.com', '424242', 'login')).error).toBe('code');
    await service.startAuth('anna@example.com', 'login', 'de');
    expect(mailer.sent).toHaveLength(1);
    expect((await service.verifyAuth('anna@example.com', '424242', 'login')).error).toBe('code');
  });

  it('alte Codes werden beim täglichen Aufräumen gelöscht', async () => {
    const { service, store, clock, mailer } = setup();
    await service.startAuth('l@example.com', 'login', 'de');
    expect(await store.getCode('l@example.com', 'login')).not.toBeNull();
    clock.now += 25 * 3_600_000;
    await service.maintenance();
    expect(await store.getCode('l@example.com', 'login')).toBeNull();
    expect((await service.verifyAuth('l@example.com', mailer.lastCode()!, 'login')).error).toBe('code');
  });

  it('die Antwort verrät nicht, ob es die Adresse schon gibt', async () => {
    const { service, mailer, clock } = setup();
    await service.startAuth('i@example.com', 'login', 'de');
    await service.verifyAuth('i@example.com', mailer.lastCode()!, 'login');
    clock.now += 60_000;
    const known = await service.startAuth('i@example.com', 'login', 'de');
    const unknown = await service.startAuth('j@example.com', 'login', 'de');
    expect(known).toEqual(unknown);
  });

  it('HTTP: Start, Bestätigung, anonyme Konten gibt es nicht mehr', async () => {
    const { service, mailer } = setup();
    const call = (method: string, path: string, body = '', headers: Record<string, string> = {}) =>
      handleApi(new Request(`https://x.test/api/${path}`, { method, body: method === 'GET' ? undefined : body, headers }), service);
    expect((await call('POST', 'account')).status).toBe(410);
    expect((await call('POST', 'auth/start', 'nonsense')).status).toBe(400);
    expect(await (await call('POST', 'auth/start', 'email kaputt\npurpose login\nlang de\nend\n')).text()).toBe('error invalid-email\n');
    expect(await (await call('POST', 'auth/start', 'email k@example.com\npurpose login\nlang de\nend\n')).text()).toBe('ok\n');
    const code = mailer.lastCode()!;
    expect(await (await call('POST', 'auth/verify', 'email k@example.com\ncode 000000\npurpose login\nend\n')).text()).toBe('error code\n');
    const ok = (await (await call('POST', 'auth/verify', `email k@example.com\ncode ${code}\npurpose login\nend\n`)).text()).trim().split(' ');
    expect(ok[0]).toBe('account');
    const games = await call('GET', 'games', '', { 'X-Account': ok[1], 'X-Secret': ok[2] });
    expect(games.status).toBe(200);
  });
});
