import { describe, expect, it } from 'vitest';
import { MemoryMailer } from '../functions/_lib/mailer';
import { Service } from '../functions/_lib/service';
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

const DAY = 86_400_000;

function setup() {
  const clock = { now: DAY * 20 };
  const mailer = new MemoryMailer();
  const service = new Service(new MemoryStore(), () => clock.now, mulberry(9), mailer);
  return { clock, mailer, service };
}

async function login(service: Service, mailer: MemoryMailer, email: string) {
  await service.startAuth(email, 'login', 'de');
  const r = await service.verifyAuth(email, mailer.lastCode()!, 'login');
  return r.account!;
}

describe('Premium-Liste des Betreibers', () => {
  it('Adresse auf der Liste hat Premium, andere nicht', async () => {
    const { service, mailer } = setup();
    service.premiumEmails = new Set(['freund@example.com']);
    const friend = await login(service, mailer, 'Freund@Example.com');
    const other = await login(service, mailer, 'andere@example.com');
    expect(await service.isPremium(friend.id)).toBe(true);
    expect(await service.isPremium(other.id)).toBe(false);
    expect((await service.quota(friend.id)).premium).toBe(true);
  });

  it('gilt auch für ein schon angemeldetes Konto, ohne neue Anmeldung', async () => {
    const { service, mailer } = setup();
    const friend = await login(service, mailer, 'freund@example.com');
    expect(await service.isPremium(friend.id)).toBe(false);
    service.premiumEmails = new Set(['freund@example.com']);
    expect(await service.isPremium(friend.id)).toBe(true);
  });

  it('läuft nicht ab, endet aber sofort, wenn die Adresse gestrichen wird', async () => {
    const { clock, service, mailer } = setup();
    service.premiumEmails = new Set(['freund@example.com']);
    const friend = await login(service, mailer, 'freund@example.com');
    clock.now += 400 * DAY;
    expect(await service.isPremium(friend.id)).toBe(true);
    service.premiumEmails = new Set();
    expect(await service.isPremium(friend.id)).toBe(false);
  });

  it('ein gekauftes Abo gilt weiter, wenn die Adresse nicht (mehr) auf der Liste steht', async () => {
    const { clock, service, mailer } = setup();
    const friend = await login(service, mailer, 'freund@example.com');
    await service.grantPremium(friend.id, clock.now + 10 * DAY, 'play');
    expect(await service.isPremium(friend.id)).toBe(true);
  });
});
