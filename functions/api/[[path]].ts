import { handleApi, isAllowedHost } from '../_lib/handler';
import { Service } from '../_lib/service';
import { BrevoMailer, NoMailer } from '../_lib/mailer';
import { FcmPusher, NoPusher } from '../_lib/push';
import { D1Store } from '../_lib/store';
import { cryptoRng } from '../_lib/rules';

interface Env {
  DB: D1Database;
  /** Geheimnis für den täglichen Wartungsaufruf (in Cloudflare als Secret gesetzt). */
  MAINTENANCE_TOKEN?: string;
  /** Brevo (transaktionale E-Mail): Schlüssel als Secret, Absenderadresse muss in Brevo bestätigt sein. */
  BREVO_API_KEY?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  /** Nur für den internen Test: Adressen (Komma-getrennt) mit festem Code `TEST_CODE`; ohne beides ist die Funktion aus. */
  TEST_EMAILS?: string;
  TEST_CODE?: string;
  /** Firebase-Dienstkonto (JSON) für Benachrichtigungen, als Secret; ohne den Schlüssel gibt es keine Benachrichtigungen. */
  FCM_SERVICE_ACCOUNT?: string;
  /** E-Mail-Adresse des Betreibers: bekommt bei jeder Meldung eines Spielers eine Mail (optional). */
  REPORT_TO?: string;
  /** Weitere Hostnamen (Komma-getrennt), die die API bedienen darf, z. B. eine eigene Domain. */
  ALLOWED_HOSTS?: string;
}

/** Alle Anfragen unter /api/* des Online-Mehrspielers (Cloudflare Pages Functions mit D1). */
export const onRequest: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  // Alte Deployment-Adressen (<hash>.rummy-game-6ke.pages.dev) und Vorschauen bedienen die API nicht.
  if (!isAllowedHost(new URL(request.url).hostname, env.ALLOWED_HOSTS ?? '')) {
    return new Response('error notfound\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const mailer = env.BREVO_API_KEY?.replace(/[^!-~]/g, '') && env.MAIL_FROM?.replace(/[^!-~]/g, '') ? new BrevoMailer(env.BREVO_API_KEY, env.MAIL_FROM, env.MAIL_FROM_NAME ?? 'Rummy') : new NoMailer();
  const testLogin = env.TEST_EMAILS && env.TEST_CODE && /^\d{6}$/.test(env.TEST_CODE)
    ? { emails: new Set(env.TEST_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)), code: env.TEST_CODE }
    : null;
  const pusher = env.FCM_SERVICE_ACCOUNT ? new FcmPusher(env.FCM_SERVICE_ACCOUNT) : new NoPusher();
  const service = new Service(new D1Store(env.DB), Date.now, cryptoRng, mailer, testLogin, pusher);
  service.reportTo = env.REPORT_TO ?? '';
  try {
    const response = await handleApi(request, service, env.MAINTENANCE_TOKEN ?? '');
    waitUntil(service.flush());
    return response;
  } catch {
    return new Response('error internal\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};
