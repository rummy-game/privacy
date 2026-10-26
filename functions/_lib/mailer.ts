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
  private apiKey: string;
  private fromEmail: string;
  private fromName: string;

  // Secrets, die per Eingabe gesetzt wurden, tragen oft Zeilenumbrüche oder Steuerzeichen: nur druckbares ASCII behalten.
  constructor(apiKey: string, fromEmail: string, fromName: string) {
    // Auch Byte-Order-Marken und Nullzeichen entfernen, die beim Eingeben über PowerShell mitkommen können.
    this.apiKey = apiKey.replace(/[^!-~]/g, '');
    this.fromEmail = fromEmail.replace(/[^!-~]/g, '');
    this.fromName = fromName.replace(/[^ -~]/g, '').trim();
  }

  async send(to: string, subject: string, text: string): Promise<boolean> {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { email: this.fromEmail, name: this.fromName }, to: [{ email: to }], subject, textContent: text }),
      });
      if (res.status >= 200 && res.status < 300) return true;
      // Für die Fehlersuche (wrangler pages deployment tail): nur Status und Meldung von Brevo, nie Schlüssel oder Adresse.
      console.error(`brevo ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    } catch (e) {
      console.error(`brevo fetch failed: ${String(e).slice(0, 100)}`);
      return false;
    }
  }
}
