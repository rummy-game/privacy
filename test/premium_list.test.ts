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
  service.premiumEmails = new Set(['freund@example.com']);
  return { clock, mailer, service };
}

async function login(service: Service, mailer: MemoryMailer, email: string) {
  await service.startAuth(email, 'login', 'de');
  const r = await service.verifyAuth(email, mailer.lastCode()!, 'login');
  return r.account!;
}

describe('Premium-Liste des Betreibers', () => {
  it('Adresse auf der Liste hat nach der Anmeldung Premium, andere nicht', async () => {
    const { service, mailer } = setup();
    const friend = await login(service, mailer, 'Freund@Example.com');
    const other = await login(service, mailer, 'andere@example.com');
    expect(await service.isPremium(friend.id)).toBe(true);
    expect(await service.isPremium(other.id)).toBe(false);
  });

  it('läuft nach 40 Tagen aus, wenn die Adresse gestrichen wird', async () => {
    const { clock, service, mailer } = setup();
    const friend = await login(service, mailer, 'freund@example.com');
    service.premiumEmails = new Set();
    clock.now += 39 * DAY;
    expect(await service.isPremium(friend.id)).toBe(true);
    clock.now += 2 * DAY;
    expect(await service.isPremium(friend.id)).toBe(false);
  });

  it('jede Anmeldung erneuert die 40 Tage', async () => {
    const { clock, service, mailer } = setup();
    const friend = await login(service, mailer, 'freund@example.com');
    clock.now += 30 * DAY;
    await login(service, mailer, 'freund@example.com');
    clock.now += 30 * DAY;
    expect(await service.isPremium(friend.id)).toBe(true);
  });

  it('ein längerer Kauf wird nicht verkürzt', async () => {
    const { clock, service, mailer } = setup();
    const friend = await login(service, mailer, 'freund@example.com');
    await service.grantPremium(friend.id, clock.now + 100 * DAY, 'play');
    await login(service, mailer, 'freund@example.com');
    clock.now += 60 * DAY;
    expect(await service.isPremium(friend.id)).toBe(true);
  });
});
