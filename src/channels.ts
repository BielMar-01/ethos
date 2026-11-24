import { Router } from "express";
import webpush from "web-push";
import { db } from "./db.js";
import { requireAuth } from "./auth.js";
import { appUrl } from "./authProvider.js";
import { sendEmail, emailReady } from "./mailer.js";

/**
 * Entrega externa dos avisos: e-mail (Resend), WhatsApp (API oficial da Meta, só com modelo aprovado e consentimento)
 * e push do navegador (Web Push/VAPID). O sino do app continua sendo o canal principal; os outros seguem a preferência
 * de cada pessoa por categoria. Cada tentativa fica em `deliveries` (e serve de dedupe para lembretes).
 */

export interface Outgoing {
  category: string;
  title: string;
  body?: string | null;
  /** Caminho do app para abrir ao clicar (ex.: "/"). */
  url?: string;
  dedupeKey?: string | null;
}

type FetchLike = typeof fetch;
let waFetch: FetchLike = fetch;
/** Só para testes. */
export const setWhatsAppFetch = (f: FetchLike) => (waFetch = f);

export const whatsappReady = () => (process.env.ETHOS_DB === "memory" ? process.env.WHATSAPP_TEST === "1" : !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_TEMPLATE));
export const pushReady = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

/** Telefone brasileiro (qualquer máscara) em formato internacional, só dígitos. */
export function toE164(phone: string): string | null {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("55") && d.length > 11) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  return `55${d}`;
}

async function sendWhatsApp(phone: string, text: string): Promise<void> {
  const res = await waFetch(`https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: { name: process.env.WHATSAPP_TEMPLATE, language: { code: process.env.WHATSAPP_LANG ?? "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 900) }] }] },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`WhatsApp: HTTP ${res.status}`);
}

type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<void>;
let pushSender: PushSender = async (sub, payload) => {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? `mailto:avisos@${new URL(appUrl()).hostname}`, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24 });
};
/** Só para testes. */
export const setPushSender = (f: PushSender) => (pushSender = f);

interface Target {
  id: number;
  email: string;
  phone: string | null;
  whatsapp_opt_in_at: string | null;
  email_on: boolean | null;
  whatsapp_on: boolean | null;
  push_on: boolean | null;
}

async function record(orgId: number, userId: number, channel: string, status: "sent" | "failed" | "skipped", dedupeKey: string | null, error?: string) {
  await db.query("INSERT INTO deliveries (organization_id, user_id, channel, status, error, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [
    orgId, userId, channel, status, error?.slice(0, 300) ?? null, status === "sent" ? dedupeKey : null,
  ]);
}

/** Já enviamos este lembrete a esta pessoa por este canal? */
async function alreadySent(userId: number, channel: string, dedupeKey: string | null): Promise<boolean> {
  if (!dedupeKey) return false;
  return (await db.query("SELECT 1 FROM deliveries WHERE user_id = $1 AND channel = $2 AND dedupe_key = $3 AND status = 'sent'", [userId, channel, dedupeKey])).length > 0;
}

/** Entrega pelos canais externos. Nunca lança. */
export async function deliverExternal(orgId: number, userIds: number[], n: Outgoing): Promise<void> {
  try {
    if (userIds.length === 0) return;
    const targets = await db.query<Target>(
      `SELECT u.id, u.email, u.phone, u.whatsapp_opt_in_at, p.email AS email_on, p.whatsapp AS whatsapp_on, p.push AS push_on
       FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id AND p.organization_id = $1 AND p.category = $2
       WHERE u.id = ANY($3::int[]) AND u.deleted_at IS NULL`,
      [orgId, n.category, userIds],
    );
    const link = `${appUrl()}${n.url ?? "/"}`;
    const text = `${n.body ? `${n.body}\n\n` : ""}Abrir no Ethos: ${link}\n\nPara escolher o que receber, acesse Notificações > Preferências.`;
    for (const t of targets) {
      if ((t.email_on ?? true) && emailReady() && !(await alreadySent(t.id, "email", n.dedupeKey ?? null))) {
        const ok = await sendEmail({ to: t.email, subject: n.title, text });
        await record(orgId, t.id, "email", ok ? "sent" : "failed", n.dedupeKey ?? null, ok ? undefined : "envio falhou");
      }
      if ((t.whatsapp_on ?? true) && t.whatsapp_opt_in_at && t.phone && whatsappReady() && !(await alreadySent(t.id, "whatsapp", n.dedupeKey ?? null))) {
        const e164 = toE164(t.phone);
        if (e164) {
          try {
            await sendWhatsApp(e164, `${n.title}${n.body ? ` — ${n.body}` : ""}`);
            await record(orgId, t.id, "whatsapp", "sent", n.dedupeKey ?? null);
          } catch (err) {
            await record(orgId, t.id, "whatsapp", "failed", null, err instanceof Error ? err.message : "erro");
          }
        }
      }
      if ((t.push_on ?? true) && (pushReady() || process.env.ETHOS_DB === "memory") && !(await alreadySent(t.id, "push", n.dedupeKey ?? null))) {
        const subs = await db.query<{ id: number; endpoint: string; p256dh: string; auth: string }>("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1", [t.id]);
        let sent = false;
        for (const s of subs) {
          try {
            await pushSender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: n.title, body: n.body ?? "", url: n.url ?? "/" }));
            sent = true;
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) await db.query("DELETE FROM push_subscriptions WHERE id = $1", [s.id]); // inscrição expirada
            else await record(orgId, t.id, "push", "failed", null, err instanceof Error ? err.message : "erro");
          }
        }
        if (sent) await record(orgId, t.id, "push", "sent", n.dedupeKey ?? null);
      }
    }
  } catch (err) {
    console.error("Falha na entrega externa:", err instanceof Error ? err.message : err);
  }
}

// ------------------------------------------------------------------ Rotas (push e consentimento)

export const channelsRouter = Router();

channelsRouter.get("/push/config", requireAuth, (_req, res) => {
  res.json({ enabled: pushReady(), public_key: pushReady() ? process.env.VAPID_PUBLIC_KEY : null });
});

channelsRouter.post("/push/subscribe", requireAuth, async (req, res) => {
  if (req.auth!.viaApiKey) return void res.status(403).json({ error: "Chaves de API não recebem push." });
  const { endpoint, keys } = req.body ?? {};
  if (typeof endpoint !== "string" || !/^https:\/\/\S{10,500}$/.test(endpoint) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string" || keys.p256dh.length > 200 || keys.auth.length > 100) {
    return void res.status(400).json({ error: "Inscrição de push inválida." });
  }
  const [count] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1", [req.auth!.user.id]);
  if (count!.n >= 10) return void res.status(409).json({ error: "Limite de 10 aparelhos com push. Remova algum." });
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.auth!.user.id, endpoint, keys.p256dh, keys.auth, req.get("user-agent")?.slice(0, 300) ?? null],
  );
  res.status(204).end();
});

channelsRouter.post("/push/unsubscribe", requireAuth, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string") return void res.status(400).json({ error: "Informe o endpoint." });
  await db.query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [req.auth!.user.id, endpoint]);
  res.status(204).end();
});

/** Consentimento de WhatsApp (LGPD): explícito, datado e revogável; exige telefone no perfil. */
channelsRouter.put("/notifications/whatsapp-consent", requireAuth, async (req, res) => {
  if (req.auth!.viaApiKey) return void res.status(403).json({ error: "Chaves de API não têm preferências." });
  const on = req.body?.opt_in;
  if (typeof on !== "boolean") return void res.status(400).json({ error: "Informe opt_in (true/false)." });
  if (on) {
    const [u] = await db.query<{ phone: string | null }>("SELECT phone FROM users WHERE id = $1", [req.auth!.user.id]);
    if (!u?.phone || !toE164(u.phone)) return void res.status(409).json({ error: "Cadastre um telefone válido em Meu perfil antes de ativar o WhatsApp." });
  }
  await db.query("UPDATE users SET whatsapp_opt_in_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [req.auth!.user.id, on]);
  res.status(204).end();
});
