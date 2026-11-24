import crypto from "node:crypto";
import { Router, type Request } from "express";
import { db, transaction } from "./db.js";
import { createSession, requireAuth } from "./auth.js";
import { decryptSecret, encryptSecret, secretsReady } from "./secrets.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { confirmPassword } from "./reauth.js";
import { generateRecoveryCodes, generateTotpSecret, hashRecovery, otpauthUri, verifyTotp } from "./totp.js";

/**
 * Verificação em duas etapas (TOTP). Fica por conta do app, não do Supabase: a sessão é do app.
 * Login com senha correta e 2FA ativo NÃO cria sessão: devolve um desafio curto (`mfa_token`) que só vira
 * sessão com um código válido (do app autenticador ou de recuperação).
 */
export const mfaRouter = Router();

const CHALLENGE_TTL_MIN = 5;
const MAX_CHALLENGE_ATTEMPTS = 5;
const challengeLimiter = new SharedRateLimiter("mfa-ip", 30, 15 * 60 * 1000);
const userLimiter = new SharedRateLimiter("mfa-user", 10, 15 * 60 * 1000);
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export const userHasMfa = async (userId: number): Promise<boolean> =>
  (await db.query("SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL", [userId])).length > 0;

/** Cria o desafio entre a senha correta e o código. O token só existe no navegador; no banco fica o hash. */
export async function startMfaChallenge(userId: number, organizationId: number): Promise<string> {
  await db.query("DELETE FROM mfa_challenges WHERE expires_at < now()");
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO mfa_challenges (id, user_id, organization_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))",
    [hashToken(token), userId, organizationId, CHALLENGE_TTL_MIN],
  );
  return token;
}

interface MfaRow {
  secret_enc: string;
  enabled_at: string | null;
  last_step: string | null;
}

/**
 * Confere um código de segundo fator: 6 dígitos = app autenticador (passo usado não vale de novo);
 * qualquer outro formato = código de recuperação (uso único).
 */
export async function checkSecondFactor(userId: number, code: unknown): Promise<boolean> {
  if (typeof code !== "string" || !code.trim() || code.length > 40) return false;
  if (!(await userLimiter.allow(`user:${userId}`))) return false;
  const clean = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(clean)) {
    const [row] = await db.query<MfaRow>("SELECT secret_enc, enabled_at, last_step FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL", [userId]);
    if (!row) return false;
    const step = verifyTotp(decryptSecret(row.secret_enc), clean, { afterStep: row.last_step === null ? null : Number(row.last_step) });
    if (step === null) return false;
    // Atômico: dois pedidos simultâneos com o mesmo código não passam os dois.
    const won = await db.query("UPDATE user_mfa SET last_step = $2 WHERE user_id = $1 AND (last_step IS NULL OR last_step < $2) RETURNING 1", [userId, step]);
    return won.length > 0;
  }
  const used = await db.query(
    "UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id",
    [userId, hashRecovery(clean)],
  );
  return used.length > 0;
}

async function newRecoveryCodes(userId: number): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await transaction(async (tx) => {
    await tx.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
    for (const c of codes) await tx.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [userId, hashRecovery(c)]);
  });
  return codes;
}

// ----------------------------------------------------------- Entrar com o código (público)

mfaRouter.post("/auth/mfa", async (req: Request, res) => {
  const token = req.body?.mfa_token;
  if (typeof token !== "string" || !token) return void res.status(400).json({ error: "Dados inválidos" });
  if (!(await challengeLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const id = hashToken(token);
  const [ch] = await db.query<{ user_id: number; organization_id: number; attempts: number }>(
    "SELECT user_id, organization_id, attempts FROM mfa_challenges WHERE id = $1 AND expires_at > now()",
    [id],
  );
  if (!ch) return void res.status(401).json({ error: "A verificação expirou. Entre novamente com e-mail e senha." });

  if (!(await checkSecondFactor(ch.user_id, req.body?.code))) {
    const [after] = await db.query<{ attempts: number }>("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts", [id]);
    if (!after || after.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await db.query("DELETE FROM mfa_challenges WHERE id = $1", [id]);
      return void res.status(401).json({ error: "Código incorreto demais. Entre novamente com e-mail e senha." });
    }
    return void res.status(401).json({ error: "Código incorreto ou já usado." });
  }
  // Uso único: consome o desafio antes de abrir a sessão.
  const taken = await db.query("DELETE FROM mfa_challenges WHERE id = $1 RETURNING id", [id]);
  if (taken.length === 0) return void res.status(401).json({ error: "A verificação expirou. Entre novamente com e-mail e senha." });

  const [who] = await db.query<{ id: number; name: string; email: string; org_name: string; role: string }>(
    `SELECT u.id, u.name, u.email, o.name AS org_name, m.role FROM users u
     JOIN organization_members m ON m.user_id = u.id AND m.organization_id = $2
     JOIN organizations o ON o.id = m.organization_id
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [ch.user_id, ch.organization_id],
  );
  if (!who) return void res.status(403).json({ error: "Usuário sem organização" });
  await createSession(res, who.id, ch.organization_id, req);
  res.json({ user: { id: who.id, name: who.name, email: who.email }, organization: { id: ch.organization_id, name: who.org_name }, role: who.role });
});

// ----------------------------------------------------------- Configurar (logado)

mfaRouter.use("/profile/mfa", requireAuth, (req, res, next) => {
  if (req.auth!.viaApiKey) return void res.status(403).json({ error: "Chaves de API não têm perfil." });
  next();
});

mfaRouter.get("/profile/mfa", async (req, res) => {
  const [row] = await db.query<{ enabled_at: string | null }>("SELECT enabled_at FROM user_mfa WHERE user_id = $1", [req.auth!.user.id]);
  const [left] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [req.auth!.user.id]);
  res.json({ available: secretsReady(), enabled: !!row?.enabled_at, enabled_at: row?.enabled_at ?? null, recovery_left: row?.enabled_at ? left!.n : 0 });
});

mfaRouter.post("/profile/mfa/setup", async (req, res) => {
  if (!secretsReady()) return void res.status(409).json({ error: "A verificação em duas etapas precisa de INTEGRATIONS_SECRET (32+ caracteres) no servidor." });
  const userId = req.auth!.user.id;
  if (!(await confirmPassword(req, res, req.body?.password))) return;
  if (await userHasMfa(userId)) return void res.status(409).json({ error: "A verificação em duas etapas já está ativa. Desative para configurar de novo." });
  const secret = generateTotpSecret();
  await db.query(
    `INSERT INTO user_mfa (user_id, secret_enc) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, enabled_at = NULL, last_step = NULL, created_at = now()`,
    [userId, encryptSecret(secret)],
  );
  res.json({ secret, uri: otpauthUri(secret, req.auth!.user.email) });
});

mfaRouter.post("/profile/mfa/enable", async (req, res) => {
  const userId = req.auth!.user.id;
  const [row] = await db.query<MfaRow>("SELECT secret_enc, enabled_at, last_step FROM user_mfa WHERE user_id = $1", [userId]);
  if (!row || row.enabled_at) return void res.status(409).json({ error: "Inicie a configuração primeiro." });
  if (!(await userLimiter.allow(`user:${userId}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const step = typeof req.body?.code === "string" ? verifyTotp(decryptSecret(row.secret_enc), req.body.code) : null;
  if (step === null) return void res.status(400).json({ error: "Código incorreto. Confira o horário do celular e tente o código atual." });
  await db.query("UPDATE user_mfa SET enabled_at = now(), last_step = $2 WHERE user_id = $1", [userId, step]);
  res.json({ recovery_codes: await newRecoveryCodes(userId) });
});

mfaRouter.post("/profile/mfa/disable", async (req, res) => {
  const userId = req.auth!.user.id;
  if (!(await confirmPassword(req, res, req.body?.password))) return;
  if (!(await userHasMfa(userId))) return void res.status(409).json({ error: "A verificação em duas etapas não está ativa." });
  if (!(await checkSecondFactor(userId, req.body?.code))) return void res.status(403).json({ error: "Código incorreto." });
  await transaction(async (tx) => {
    await tx.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
    await tx.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
  });
  res.status(204).end();
});

mfaRouter.post("/profile/mfa/recovery-codes", async (req, res) => {
  const userId = req.auth!.user.id;
  if (!(await confirmPassword(req, res, req.body?.password))) return;
  if (!(await userHasMfa(userId))) return void res.status(409).json({ error: "A verificação em duas etapas não está ativa." });
  if (!(await checkSecondFactor(userId, req.body?.code))) return void res.status(403).json({ error: "Código incorreto." });
  res.json({ recovery_codes: await newRecoveryCodes(userId) });
});
