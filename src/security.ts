import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { describeAgent } from "./agent.js";
import { sendEmail } from "./mailer.js";
import { notify } from "./notifications.js";
import { appUrl } from "./authProvider.js";

/**
 * Endurecimento de conta: política de senha (com checagem de vazamentos), alerta de aparelho novo e de mudanças sensíveis,
 * bloqueio por país, expiração por inatividade (por organização), registro de segurança do próprio usuário e
 * anonimização de auditoria de contas encerradas após o prazo de guarda.
 */

// ------------------------------------------------------------------ Política de senha

const COMMON = new Set(["12345678", "123456789", "1234567890", "password", "password1", "senha123", "senha1234", "qwertyui", "qwerty123", "abc12345", "11111111", "00000000", "iloveyou", "admin123", "brasil123", "mudar123"]);

type FetchLike = typeof fetch;
let pwnedFetch: FetchLike | null = process.env.ETHOS_DB === "memory" ? null : fetch;
/** Só para testes: define (ou, com null, desliga) a consulta de senhas vazadas. */
export const setPwnedFetch = (f: FetchLike | null) => (pwnedFetch = f);

/** A senha já apareceu em vazamentos? k-anonimato: só os 5 primeiros caracteres do SHA-1 saem do servidor. Se o serviço falhar, libera. */
export async function isPwned(password: string): Promise<boolean> {
  if (!pwnedFetch) return false;
  try {
    const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
    const res = await pwnedFetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const suffix = sha1.slice(5);
    return (await res.text()).split(/\r?\n/).some((line) => {
      const [s, n] = line.split(":");
      return s === suffix && Number(n) > 0;
    });
  } catch {
    return false;
  }
}

/** Devolve o motivo da recusa ou null se a senha é aceitável. */
export async function passwordProblem(password: string, email?: string): Promise<string | null> {
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return "Senha muito comum. Escolha outra.";
  if (email && (lower === email.toLowerCase() || lower === email.split("@")[0]!.toLowerCase())) return "A senha não pode ser igual ao seu e-mail.";
  if (await isPwned(password)) return "Esta senha já apareceu em vazamentos de dados. Escolha outra.";
  return null;
}

// ------------------------------------------------------------------ Aparelho novo e alertas

const fingerprint = (ua: string | null | undefined) => crypto.createHash("sha256").update(describeAgent(ua)).digest("hex").slice(0, 32);

/**
 * Alerta de segurança: sino (categoria "seguranca") e e-mail direto (sempre, mesmo com a preferência desligada:
 * é aviso de conta). Nunca lança.
 */
export async function securityAlert(userId: number, orgId: number | null, title: string, body: string, opts: { emailTo?: string } = {}): Promise<void> {
  try {
    const [u] = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
    if (!u) return;
    if (orgId) await notify(orgId, [userId], { category: "seguranca", kind: "security", title, body });
    await sendEmail({ to: opts.emailTo ?? u.email, subject: `Ethos: ${title}`, text: `${body}\n\nSe não foi você, entre em ${appUrl()} e troque a senha em Meu perfil. Para encerrar todas as sessões, use "Encerrar todas as outras".` });
  } catch (err) {
    console.error("Falha no alerta de segurança:", err instanceof Error ? err.message : err);
  }
}

/** Registra o aparelho do login; se é a primeira vez que ele aparece (e a pessoa já tinha outros), avisa. */
export async function noteLogin(req: Request, userId: number, orgId: number): Promise<void> {
  try {
    const fp = fingerprint(req.get("user-agent"));
    const [known] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM known_devices WHERE user_id = $1", [userId]);
    const seen = await db.query("UPDATE known_devices SET last_seen_at = now() WHERE user_id = $1 AND fingerprint = $2 RETURNING 1", [userId, fp]);
    if (seen.length === 0) await db.query("INSERT INTO known_devices (user_id, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, fp]);
    if (seen.length === 0 && (known?.n ?? 0) > 0) {
      await securityAlert(userId, orgId, "Novo acesso à sua conta", `Entrada em um aparelho novo: ${describeAgent(req.get("user-agent"))} (IP ${req.ip ?? "desconhecido"}).`);
    }
  } catch (err) {
    console.error("Falha ao registrar aparelho:", err instanceof Error ? err.message : err);
  }
}

// ------------------------------------------------------------------ País permitido

const COUNTRY_HEADERS = ["x-vercel-ip-country", "cf-ipcountry"];
export const requestCountry = (req: Request): string | null => {
  for (const h of COUNTRY_HEADERS) {
    const v = req.get(h);
    if (v && /^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  }
  return null;
};

/** O login vindo deste país é permitido para esta conta? Sem lista ou sem cabeçalho do proxy, sim. */
export async function countryAllowed(req: Request, userId: number): Promise<boolean> {
  const [u] = await db.query<{ allowed_countries: string | null }>("SELECT allowed_countries FROM users WHERE id = $1", [userId]);
  if (!u?.allowed_countries) return true;
  const country = requestCountry(req);
  return !country || u.allowed_countries.split(",").includes(country);
}

export const COUNTRY_BLOCKED_MESSAGE = "Entrada bloqueada: esta conta só aceita acessos de países autorizados por você em Meu perfil.";

// ------------------------------------------------------------------ Auditoria de contas encerradas

/** Apaga nome, e-mail, IP e aparelho dos registros de auditoria de contas encerradas há mais de `days` dias. */
export async function anonymizeOldAudit(days = Number(process.env.AUDIT_ANON_AFTER_DAYS ?? 1825)): Promise<number> {
  const rows = await db.query(
    `UPDATE audit_logs a SET user_name = 'Usuário removido', user_email = NULL, ip = NULL, user_agent = NULL
     FROM users u
     WHERE a.user_id = u.id AND u.deleted_at IS NOT NULL AND u.deleted_at < now() - make_interval(days => $1::int)
       AND (a.user_email IS NOT NULL OR a.ip IS NOT NULL OR a.user_name <> 'Usuário removido')
     RETURNING a.id`,
    [days],
  );
  return rows.length;
}

// ------------------------------------------------------------------ Rotas

export const securityRouter = Router();
const notApi = (req: Request, res: Response, next: () => void) => (req.auth?.viaApiKey ? void res.status(403).json({ error: "Chaves de API não têm perfil." }) : next());

/** Histórico de segurança da própria pessoa (logins, falhas, mudanças de senha/e-mail/2FA), de todas as organizações. */
securityRouter.get("/profile/security-log", requireAuth, notApi, async (req, res) => {
  const rows = await db.query<{ id: string; created_at: string; kind: string; summary: string; status: number | null; ip: string | null; user_agent: string | null }>(
    `SELECT id::text, created_at, kind, summary, status, ip, user_agent FROM audit_logs
     WHERE user_id = $1 AND kind IN ('auth','denied') ORDER BY id DESC LIMIT 100`,
    [req.auth!.user.id],
  );
  res.json({ items: rows.map((r) => ({ id: r.id, created_at: r.created_at, summary: r.summary, ok: (r.status ?? 200) < 400, ip: r.ip, device: describeAgent(r.user_agent) })) });
});

/** País(es) permitidos para entrar (ex. "BR" ou "BR,PT"). Vazio = sem restrição. Recusa se bloquearia o próprio pedido. */
securityRouter.get("/profile/security", requireAuth, notApi, async (req, res) => {
  const [u] = await db.query<{ allowed_countries: string | null }>("SELECT allowed_countries FROM users WHERE id = $1", [req.auth!.user.id]);
  res.json({ allowed_countries: u?.allowed_countries ?? "", current_country: requestCountry(req) });
});

securityRouter.put("/profile/security", requireAuth, notApi, async (req, res) => {
  const raw: string = typeof req.body?.allowed_countries === "string" ? req.body.allowed_countries : "";
  const list = [...new Set(raw.split(/[\s,;]+/).filter(Boolean).map((c: string) => c.toUpperCase()))];
  if (list.some((c) => !/^[A-Z]{2}$/.test(c)) || list.length > 20) return void res.status(400).json({ error: "Use códigos de país com 2 letras separados por vírgula (ex.: BR, PT)." });
  const here = requestCountry(req);
  if (list.length > 0 && here && !list.includes(here)) return void res.status(409).json({ error: `Você está acessando de ${here}; incluir só outros países bloquearia a sua própria entrada. Inclua ${here} na lista.` });
  await db.query("UPDATE users SET allowed_countries = $2 WHERE id = $1", [req.auth!.user.id, list.length ? list.join(",") : null]);
  res.json({ allowed_countries: list.join(",") });
});

/** Configuração de segurança da organização (admin): tempo de inatividade para encerrar a sessão. */
securityRouter.get("/settings/security", requireAuth, requireRole("admin"), async (req, res) => {
  const [o] = await db.query<{ session_idle_minutes: number | null }>("SELECT session_idle_minutes FROM organizations WHERE id = $1", [req.auth!.organization.id]);
  res.json({ session_idle_minutes: o?.session_idle_minutes ?? null });
});

securityRouter.put("/settings/security", requireAuth, requireRole("admin"), async (req, res) => {
  const v = req.body?.session_idle_minutes;
  if (v !== null && (!Number.isInteger(v) || v < 15 || v > 1440)) return void res.status(400).json({ error: "Informe de 15 a 1440 minutos, ou null para desligar." });
  await db.query("UPDATE organizations SET session_idle_minutes = $2 WHERE id = $1", [req.auth!.organization.id, v]);
  res.json({ session_idle_minutes: v });
});
