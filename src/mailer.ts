/**
 * Envio de e-mail do próprio Ethos (avisos, segurança, segunda via). Provedor: Resend (HTTP, sem dependência).
 * Configure RESEND_API_KEY e EMAIL_FROM ("Ethos <avisos@seu-dominio.com.br>", domínio verificado no Resend).
 * Sem a configuração nada é enviado (o app segue funcionando; só os avisos por e-mail ficam desligados).
 * Em testes (ETHOS_DB=memory) as mensagens ficam em `memoryMailer.outbox`.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

type FetchLike = typeof fetch;

export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  async send(m: MailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend: HTTP ${res.status}`);
  }
}

export class MemoryMailer implements Mailer {
  outbox: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> {
    this.outbox.push(m);
  }
}

let mailer: Mailer | null | undefined;
export const memoryMailer = new MemoryMailer();

export function getMailer(): Mailer | null {
  if (mailer !== undefined) return mailer;
  if (process.env.ETHOS_DB === "memory") mailer = memoryMailer;
  else if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) mailer = new ResendMailer(process.env.RESEND_API_KEY, process.env.EMAIL_FROM);
  else mailer = null;
  return mailer;
}

export const emailReady = () => getMailer() !== null;

/** Envia sem nunca lançar. Devolve false se não há provedor ou se o envio falhou. */
export async function sendEmail(m: MailMessage): Promise<boolean> {
  const mm = getMailer();
  if (!mm) return false;
  try {
    await mm.send({ ...m, subject: m.subject.slice(0, 200) });
    return true;
  } catch (err) {
    console.error("Falha ao enviar e-mail:", err instanceof Error ? err.message : err);
    return false;
  }
}
