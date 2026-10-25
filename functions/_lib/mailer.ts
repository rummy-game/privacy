// Versand der Bestätigungscodes. Der Dienst kennt nur die Schnittstelle; produktiv läuft Brevo (transaktionale
// E-Mail über die HTTP-Schnittstelle, kein SMTP nötig).

export interface Mailer {
  /** `true`, wenn der Anbieter die Mail angenommen hat. */
  send(to: string, subject: string, text: string): Promise<boolean>;
}

/** Ohne Zugangsdaten: kein Versand, der Dienst meldet „mail“. */
export class NoMailer implements Mailer {
  async send(): Promise<boolean> {
    return false;
  }
}

/** Sammelt die Mails im Arbeitsspeicher, für Tests. */
export class MemoryMailer implements Mailer {
  sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(to: string, subject: string, text: string): Promise<boolean> {
    this.sent.push({ to, subject, text });
    return true;
  }
  /** Der zuletzt verschickte sechsstellige Code. */
  lastCode(): string | null {
    const last = this.sent[this.sent.length - 1];
    return last?.text.match(/\b(\d{6})\b/)?.[1] ?? null;
  }
}

export class BrevoMailer implements Mailer {
  constructor(
    private apiKey: string,
    private fromEmail: string,
    private fromName: string,
  ) {}

  async send(to: string, subject: string, text: string): Promise<boolean> {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { email: this.fromEmail, name: this.fromName }, to: [{ email: to }], subject, textContent: text }),
      });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }
}
