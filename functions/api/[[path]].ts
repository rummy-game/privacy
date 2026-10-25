import { handleApi } from '../_lib/handler';
import { Service } from '../_lib/service';
import { BrevoMailer, NoMailer } from '../_lib/mailer';
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
}

/** Alle Anfragen unter /api/* des Online-Mehrspielers (Cloudflare Pages Functions mit D1). */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const mailer = env.BREVO_API_KEY && env.MAIL_FROM ? new BrevoMailer(env.BREVO_API_KEY, env.MAIL_FROM, env.MAIL_FROM_NAME ?? 'Rummy') : new NoMailer();
  const service = new Service(new D1Store(env.DB), Date.now, cryptoRng, mailer);
  try {
    return await handleApi(request, service, env.MAINTENANCE_TOKEN ?? '');
  } catch {
    return new Response('error internal\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};
