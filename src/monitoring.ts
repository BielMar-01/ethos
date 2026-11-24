import { Router, type Request } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { sendEmail } from "./mailer.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { periodicJobs } from "./reminders.js";
import { appUrl } from "./authProvider.js";

/**
 * Monitoramento de erros: guarda os erros 5xx do servidor e os erros de JavaScript do navegador (sem corpo de requisição,
 * sem query string, sem dados pessoais) e avisa por e-mail (ERROR_ALERT_EMAILS) quando há uma enxurrada (≥ 10 em 10 min, no máximo 1 aviso/hora).
 * Para um serviço externo (Sentry, Datadog) use o webhook/log da hospedagem; aqui é o básico, funcionando sem conta externa.
 */
export const monitoringRouter = Router();

const clientLimiter = new SharedRateLimiter("client-errors", 20, 10 * 60 * 1000);
const alertLimiter = new SharedRateLimiter("error-alert", 1, 60 * 60 * 1000);
const BURST = 10;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
const cleanPath = (p: unknown) => clip(typeof p === "string" ? p.split(/[?#]/)[0] : null, 200);

/** Registra um erro do servidor. Nunca lança. */
export async function captureServerError(err: unknown, req: Request, status = 500): Promise<void> {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    // Mensagens podem trazer valores de SQL: guardamos só o começo, e nada do corpo da requisição.
    await db.query("INSERT INTO error_logs (organization_id, source, message, stack, method, path, status) VALUES ($1,'server',$2,$3,$4,$5,$6)", [
      req.auth?.organization.id ?? null, e.message.slice(0, 300), clip(e.stack, 2000), req.method, cleanPath(req.originalUrl), status,
    ]);
    await maybeAlert();
  } catch {
    /* monitorar não pode derrubar a resposta */
  }
}

async function maybeAlert(): Promise<void> {
  const [r] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM error_logs WHERE source = 'server' AND created_at > now() - interval '10 minutes'");
  if ((r?.n ?? 0) < BURST || !(await alertLimiter.allow("global"))) return;
  // Erros do servidor são da PLATAFORMA: o aviso vai só para quem opera (ERROR_ALERT_EMAILS), nunca para os administradores de cada organização.
  const to = (process.env.ERROR_ALERT_EMAILS ?? '').split(',').map((s) => s.trim()).filter((s) => /^\S+@\S+\.\S+$/.test(s)).slice(0, 10);
  for (const email of to) await sendEmail({ to: email, subject: 'Ethos: muitos erros no servidor', text: `Foram registrados ${r!.n} erros do servidor nos últimos 10 minutos. Veja em Administração > Integrações > Monitoramento (${appUrl()}).` });
}

/** Erros do navegador (script quebrado, tela que falhou). Aceita de quem está logado ou não, com limite por IP. */
monitoringRouter.post("/client-errors", async (req, res) => {
  if (!(await clientLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitos relatórios de erro." });
  const message = clip(req.body?.message, 300);
  if (!message) return void res.status(400).json({ error: "Informe message." });
  await db.query("INSERT INTO error_logs (organization_id, source, message, stack, path) VALUES ($1,'client',$2,$3,$4)", [req.auth?.organization.id ?? null, message, clip(req.body?.stack, 2000), cleanPath(req.body?.url)]);
  res.status(204).end();
});

monitoringRouter.get("/admin/errors", requireAuth, requireRole("admin"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  // O administrador vê os erros da própria organização e os globais de servidor (sem organização identificada).
  const items = await db.query(
    "SELECT id, source, message, stack, method, path, status, created_at FROM error_logs WHERE organization_id = $1 OR organization_id IS NULL ORDER BY id DESC LIMIT 100",
    [orgId],
  );
  const [c] = await db.query<{ n: number; server: number; client: number }>(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE source = 'server')::int AS server, count(*) FILTER (WHERE source = 'client')::int AS client FROM error_logs WHERE (organization_id = $1 OR organization_id IS NULL) AND created_at > now() - interval '24 hours'",
    [orgId],
  );
  res.json({ items, last_24h: c });
});

monitoringRouter.delete("/admin/errors", requireAuth, requireRole("admin"), async (req, res) => {
  await db.query("DELETE FROM error_logs WHERE organization_id = $1 OR organization_id IS NULL", [req.auth!.organization.id]);
  res.status(204).end();
});

periodicJobs.push({ name: "limpar registros de erro antigos", run: () => db.query("DELETE FROM error_logs WHERE created_at < now() - interval '30 days'") });
