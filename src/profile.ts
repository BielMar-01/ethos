import crypto from "node:crypto";
import { Router } from "express";
import { db, isUniqueViolation, transaction } from "./db.js";
import { SESSION_COOKIE, currentSessionId, requireAuth } from "./auth.js";
import { AuthProviderError, appUrl, getAuthProvider } from "./authProvider.js";
import { isRealDate } from "./crud.js";
import { formatDocument, formatPhone } from "./brFormat.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { confirmPassword } from "./reauth.js";
import { checkSecondFactor, userHasMfa } from "./mfa.js";
import { detectImage, rawImage } from "./photos.js";

/**
 * "Meu perfil": cada pessoa edita os próprios dados (nome, telefone, CPF, nascimento), troca o e-mail e a senha
 * e encerra as outras sessões. Vale para todos os papéis, sempre sobre o usuário da sessão (nunca um id do cliente).
 * Trocar e-mail e senha exige a senha atual. A senha nunca é gravada na auditoria (a auditoria não guarda o corpo).
 */
export const profileRouter = Router();
profileRouter.use("/profile", requireAuth, (req, res, next) => {
  if (req.auth!.viaApiKey) return void res.status(403).json({ error: "Chaves de API não têm perfil." });
  next();
});

const exportLimiter = new SharedRateLimiter("profile-export", 5, 60 * 60 * 1000);
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

interface ProfileRow {
  id: number;
  name: string;
  email: string;
  pending_email: string | null;
  phone: string | null;
  document: string | null;
  birth_date: string | null;
  created_at: string;
  has_avatar: boolean;
  avatar_version: number | null;
}

const load = async (userId: number) =>
  (
    await db.query<ProfileRow>(
      `SELECT u.id, u.name, u.email, u.pending_email, u.phone, u.document, u.birth_date, u.created_at,
              (a.user_id IS NOT NULL) AS has_avatar, (extract(epoch FROM a.updated_at) * 1000)::bigint::float8 AS avatar_version
       FROM users u LEFT JOIN user_avatars a ON a.user_id = u.id WHERE u.id = $1`,
      [userId],
    )
  )[0]!;

profileRouter.get("/profile", async (req, res) => {
  const a = req.auth!;
  const organizations = await db.query("SELECT o.id, o.name, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY o.name", [a.user.id]);
  res.json({ user: await load(a.user.id), role: a.role, organization: a.organization, organizations });
});

profileRouter.put("/profile", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const cur = await load(req.auth!.user.id);

  const name = b.name === undefined ? cur.name : typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 100) return void res.status(400).json({ error: "Informe seu nome (de 2 a 100 caracteres)." });

  let phone = cur.phone;
  if (b.phone !== undefined) {
    const raw = typeof b.phone === "string" ? b.phone.trim() : "";
    if (!raw) phone = null;
    else {
      let d = raw.replace(/\D/g, "");
      if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
      if (d.length !== 10 && d.length !== 11) return void res.status(400).json({ error: "Telefone inválido. Use DDD + número, por exemplo (11) 91234-5678." });
      phone = formatPhone(d);
    }
  }

  let document = cur.document;
  if (b.document !== undefined) {
    const raw = typeof b.document === "string" ? b.document.trim() : "";
    if (!raw) document = null;
    else {
      const d = raw.replace(/\D/g, "");
      if (d.length !== 11 && d.length !== 14) return void res.status(400).json({ error: "CPF ou CNPJ inválido: informe 11 ou 14 números." });
      document = formatDocument(d);
    }
  }

  let birth = cur.birth_date;
  if (b.birth_date !== undefined) {
    const raw = typeof b.birth_date === "string" ? b.birth_date.trim() : "";
    if (!raw) birth = null;
    else {
      if (!isRealDate(raw) || raw < "1900-01-01" || raw > new Date().toISOString().slice(0, 10)) return void res.status(400).json({ error: "Data de nascimento inválida." });
      birth = raw;
    }
  }

  await db.query("UPDATE users SET name = $1, phone = $2, document = $3, birth_date = $4 WHERE id = $5", [name, phone, document, birth, req.auth!.user.id]);
  res.json({ user: await load(req.auth!.user.id) });
});

/**
 * Troca de e-mail COM verificação: o provedor de identidade manda um link ao endereço NOVO e o login só muda depois
 * do clique (o app espelha em /api/auth/email-confirmed). Até lá vale o e-mail antigo; pedir de novo substitui o pedido.
 */
profileRouter.post("/profile/email", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) return void res.status(400).json({ error: "Informe um e-mail válido." });
  if (email === req.auth!.user.email) return void res.status(400).json({ error: "Este já é o seu e-mail." });
  const authId = await confirmPassword(req, res, req.body?.password);
  if (!authId) return;
  const taken = await db.query("SELECT 1 FROM users WHERE (email = $1 OR pending_email = $1) AND id <> $2 AND deleted_at IS NULL", [email, req.auth!.user.id]);
  if (taken.length > 0) return void res.status(409).json({ error: "Já existe uma conta com este e-mail." });
  const [cur] = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [req.auth!.user.id]);
  try {
    await getAuthProvider().requestEmailChange(cur!.email, req.body.password, email, `${appUrl()}/`);
  } catch (err) {
    if (err instanceof AuthProviderError && err.code === "exists") return void res.status(409).json({ error: "Já existe uma conta com este e-mail." });
    if (err instanceof AuthProviderError && err.code === "rate_limited") return void res.status(429).json({ error: "O provedor limitou o envio de e-mails. Tente de novo mais tarde." });
    if (err instanceof AuthProviderError) return void res.status(503).json({ error: "Não foi possível enviar o e-mail de confirmação agora. Tente de novo em instantes." });
    throw err;
  }
  await db.query("UPDATE users SET pending_email = $1, pending_email_at = now() WHERE id = $2", [email, req.auth!.user.id]);
  res.status(202).json({ user: await load(req.auth!.user.id), message: `Enviamos um link de confirmação para ${email}. O e-mail de acesso só muda depois que você clicar nele.` });
});

profileRouter.post("/profile/password", async (req, res) => {
  const next = req.body?.new_password;
  if (typeof next !== "string" || next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
    return void res.status(400).json({ error: `A nova senha deve ter de ${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres.` });
  }
  if (next === req.body?.current_password) return void res.status(400).json({ error: "A nova senha deve ser diferente da atual." });
  const authId = await confirmPassword(req, res, req.body?.current_password);
  if (!authId) return;
  try {
    await getAuthProvider().setPassword(authId, next);
  } catch (err) {
    if (err instanceof AuthProviderError && err.code === "weak_password") return void res.status(400).json({ error: "Senha fraca demais. Escolha outra." });
    throw err;
  }
  // Troca de senha derruba as outras sessões (a atual continua).
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [req.auth!.user.id, currentSessionId(req) ?? ""]);
  res.status(204).end();
});

profileRouter.post("/profile/sessions/logout-others", async (req, res) => {
  const rows = await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id", [req.auth!.user.id, currentSessionId(req) ?? ""]);
  res.json({ ended: rows.length });
});

// ------------------------------------------------------------------ Aparelhos (sessões)

const refOf = (sessionId: string) => crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);

/** "Chrome no Windows": só para a pessoa reconhecer o aparelho. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "Aparelho desconhecido";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "outro sistema";
  return `${browser} em ${os}`;
}

profileRouter.get("/profile/sessions", async (req, res) => {
  const current = currentSessionId(req);
  const rows = await db.query<{ id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; organization_name: string }>(
    `SELECT s.id, s.user_agent, s.ip, s.created_at, s.last_seen_at, o.name AS organization_name
     FROM sessions s JOIN organizations o ON o.id = s.organization_id
     WHERE s.user_id = $1 AND s.expires_at > now() ORDER BY s.last_seen_at DESC`,
    [req.auth!.user.id],
  );
  res.json({
    items: rows.map((s) => ({
      ref: refOf(s.id),
      current: s.id === current,
      device: describeAgent(s.user_agent),
      ip: s.ip,
      organization: s.organization_name,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
    })),
  });
});

profileRouter.delete("/profile/sessions/:ref", async (req, res) => {
  const ref = String(req.params.ref);
  const rows = await db.query<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1", [req.auth!.user.id]);
  const target = rows.find((s) => refOf(s.id) === ref);
  if (!target) return void res.status(404).json({ error: "Sessão não encontrada." });
  if (target.id === currentSessionId(req)) return void res.status(400).json({ error: "Esta é a sessão atual. Use Sair para encerrá-la." });
  await db.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2", [target.id, req.auth!.user.id]);
  res.status(204).end();
});

// ------------------------------------------------------------------ Foto de perfil

const MAX_AVATAR_BYTES = 1024 * 1024;

profileRouter.put("/profile/avatar", rawImage, async (req, res) => {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Envie a imagem (JPEG, PNG ou WebP) no corpo da requisição." });
  if (body.length > MAX_AVATAR_BYTES) return void res.status(413).json({ error: "A foto de perfil deve ter até 1 MB." });
  const type = detectImage(body);
  if (!type) return void res.status(400).json({ error: "Arquivo não é uma imagem JPEG, PNG ou WebP válida." });
  await db.query(
    `INSERT INTO user_avatars (user_id, content_type, data) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()`,
    [req.auth!.user.id, type, body],
  );
  res.json({ user: await load(req.auth!.user.id) });
});

profileRouter.get("/profile/avatar", async (req, res) => {
  const [a] = await db.query<{ content_type: string; data: Uint8Array }>("SELECT content_type, data FROM user_avatars WHERE user_id = $1", [req.auth!.user.id]);
  if (!a) return void res.status(404).json({ error: "Sem foto de perfil." });
  res.set({ "Content-Type": a.content_type, "Content-Disposition": "inline", "Cache-Control": "private, max-age=3600" });
  res.send(Buffer.from(a.data));
});

profileRouter.delete("/profile/avatar", async (req, res) => {
  await db.query("DELETE FROM user_avatars WHERE user_id = $1", [req.auth!.user.id]);
  res.status(204).end();
});

// ------------------------------------------------------------------ LGPD: exportar e encerrar a conta

/** Cópia dos dados pessoais que o Ethos guarda sobre a própria pessoa (LGPD, art. 18). Nunca inclui senhas nem segredos. */
profileRouter.get("/profile/export", async (req, res) => {
  const me = req.auth!.user.id;
  if (!(await exportLimiter.allow(`user:${me}`))) return void res.status(429).json({ error: "Você já exportou várias vezes. Tente novamente mais tarde." });
  const user = await load(me);
  const memberships = await db.query(
    `SELECT o.name AS organization, m.role, m.created_at,
            t.name AS tenant_name, t.document AS tenant_document, t.email AS tenant_email, t.phone AS tenant_phone,
            ow.name AS owner_name, ow.document AS owner_document, ow.email AS owner_email, ow.phone AS owner_phone
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     LEFT JOIN tenants t ON t.id = m.tenant_id LEFT JOIN owners ow ON ow.id = m.owner_id
     WHERE m.user_id = $1 ORDER BY o.name`,
    [me],
  );
  const sessions = await db.query("SELECT user_agent, ip, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1", [me]);
  const [mfa] = await db.query<{ enabled_at: string | null }>("SELECT enabled_at FROM user_mfa WHERE user_id = $1", [me]);
  const notifications = await db.query("SELECT category, title, body, created_at, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000", [me]);
  const preferences = await db.query("SELECT category, in_app FROM notification_preferences WHERE user_id = $1", [me]);
  const activity = await db.query("SELECT created_at, kind, summary, ip, user_agent FROM audit_logs WHERE user_id = $1 ORDER BY id DESC LIMIT 5000", [me]);
  const { id: _id, has_avatar: _h, avatar_version: _v, ...profile } = user;
  res.set({ "Content-Disposition": `attachment; filename="meus-dados-ethos.json"`, "Cache-Control": "no-store" });
  res.json({
    exported_at: new Date().toISOString(),
    about: "Dados pessoais do Ethos sobre você. Registros da administradora (contratos, cobranças etc.) pertencem a ela: peça a ela uma cópia.",
    profile: { ...profile, has_avatar: user.has_avatar },
    organizations: memberships,
    two_factor: { enabled: !!mfa?.enabled_at, enabled_at: mfa?.enabled_at ?? null },
    sessions,
    notifications,
    notification_preferences: preferences,
    activity,
  });
});

/**
 * Encerra a PRÓPRIA conta: apaga login, dados pessoais (nome, contato, documento, foto, 2FA, notificações) e acessos.
 * Os registros da administradora (contratos, cobranças, recibos) e o registro de auditoria (append-only) permanecem, como
 * a lei exige guardar. Quem é o único administrador de uma organização precisa passar a função antes.
 */
profileRouter.post("/profile/delete", async (req, res) => {
  const me = req.auth!.user.id;
  if (req.body?.confirm !== "EXCLUIR") return void res.status(400).json({ error: 'Digite EXCLUIR para confirmar.' });
  const sole = await db.query<{ name: string }>(
    `SELECT o.name FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND m.role = 'admin'
       AND NOT EXISTS (SELECT 1 FROM organization_members x WHERE x.organization_id = m.organization_id AND x.role = 'admin' AND x.user_id <> $1)`,
    [me],
  );
  if (sole.length > 0) {
    return void res.status(409).json({ error: `Você é o único administrador de: ${sole.map((s) => s.name).join(", ")}. Promova outra pessoa a administrador antes de encerrar a conta.` });
  }
  const authId = await confirmPassword(req, res, req.body?.password);
  if (!authId) return;
  if ((await userHasMfa(me)) && !(await checkSecondFactor(me, req.body?.code))) return void res.status(403).json({ error: "Informe o código da verificação em duas etapas." });

  await transaction(async (tx) => {
    for (const table of ["sessions", "user_mfa", "mfa_recovery_codes", "mfa_challenges", "user_avatars", "notifications", "notification_preferences", "organization_members"]) {
      await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [me]);
    }
    await tx.query(
      `UPDATE users SET name = 'Conta encerrada', email = $2, pending_email = NULL, pending_email_at = NULL, phone = NULL,
              document = NULL, birth_date = NULL, auth_id = $3, deleted_at = now() WHERE id = $1`,
      [me, `removido-${me}@excluido.invalid`, crypto.randomUUID()],
    );
  });
  await getAuthProvider().deleteUser(authId).catch((err) => console.error("Falha ao remover credencial:", err instanceof Error ? err.message : err));
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});
