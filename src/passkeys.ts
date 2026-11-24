import crypto from "node:crypto";
import { Router, type Request } from "express";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { db } from "./db.js";
import { createSession, requireAuth } from "./auth.js";
import { appUrl, getAuthProvider } from "./authProvider.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { confirmPassword } from "./reauth.js";
import { COUNTRY_BLOCKED_MESSAGE, countryAllowed, noteLogin } from "./security.js";
import { startMfaChallenge, userHasMfa } from "./mfa.js";

/**
 * Entrada sem senha por passkey (WebAuthn: biometria, chave de segurança, celular) e entrada com Google/Microsoft
 * pelo Supabase Auth. Passkey conta como verificação forte (não pede o código do 2FA). Login social NÃO cria conta:
 * só entra quem já tem acesso (convite) e, se tiver 2FA, ainda precisa do código.
 */
export const passkeysRouter = Router();

const CHALLENGE_TTL_MIN = 5;
const limiter = new SharedRateLimiter("passkey", 30, 15 * 60 * 1000);
const oauthLimiter = new SharedRateLimiter("oauth", 20, 15 * 60 * 1000);
const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** Origem e domínio (rpID) esperados: a origem do próprio pedido, desde que seja o host do servidor ou APP_URL. */
function relyingParty(req: Request): { origin: string; rpID: string } {
  const app = new URL(appUrl());
  const origin = req.get("origin");
  try {
    if (origin) {
      const o = new URL(origin);
      if (o.host === req.get("host") || o.host === app.host) return { origin: o.origin, rpID: o.hostname };
    }
  } catch {
    /* origem inválida: cai no padrão */
  }
  return { origin: app.origin, rpID: app.hostname };
}

async function saveChallenge(kind: "register" | "login", challenge: string, userId: number | null): Promise<string> {
  await db.query("DELETE FROM webauthn_challenges WHERE expires_at < now()");
  const token = crypto.randomBytes(24).toString("base64url");
  await db.query("INSERT INTO webauthn_challenges (id, kind, user_id, challenge, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))", [hash(token), kind, userId, challenge, CHALLENGE_TTL_MIN]);
  return token;
}

/** Consome o desafio (uso único). */
async function takeChallenge(token: unknown, kind: "register" | "login"): Promise<{ challenge: string; user_id: number | null } | null> {
  if (typeof token !== "string" || !token) return null;
  const [row] = await db.query<{ challenge: string; user_id: number | null }>(
    "DELETE FROM webauthn_challenges WHERE id = $1 AND kind = $2 AND expires_at > now() RETURNING challenge, user_id",
    [hash(token), kind],
  );
  return row ?? null;
}

/** Abre a sessão do usuário e responde como o login normal. Aplica a restrição de país. */
export async function finishLogin(req: Request, res: import("express").Response, userId: number, opts: { viaPasskey: boolean }): Promise<void> {
  const [user] = await db.query<{ id: number; name: string; email: string }>("SELECT id, name, email FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
  const [m] = await db.query<{ id: number; name: string; role: string }>(
    `SELECT o.id, o.name, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY m.id LIMIT 1`,
    [userId],
  );
  if (!user || !m) return void res.status(403).json({ error: "Usuário sem organização" });
  if (!(await countryAllowed(req, userId))) return void res.status(403).json({ error: COUNTRY_BLOCKED_MESSAGE });
  if (!opts.viaPasskey && (await userHasMfa(userId))) {
    return void res.json({ mfa_required: true, mfa_token: await startMfaChallenge(userId, m.id) });
  }
  await createSession(res, user.id, m.id, req);
  await noteLogin(req, user.id, m.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email }, organization: { id: m.id, name: m.name }, role: m.role });
}

// ------------------------------------------------------------------ Cadastro de passkeys (logado)

passkeysRouter.use("/profile/passkeys", requireAuth, (req, res, next) => {
  if (req.auth!.viaApiKey) return void res.status(403).json({ error: "Chaves de API não têm perfil." });
  next();
});

passkeysRouter.get("/profile/passkeys", async (req, res) => {
  const items = await db.query("SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at", [req.auth!.user.id]);
  res.json({ items });
});

passkeysRouter.post("/profile/passkeys/options", async (req, res) => {
  const me = req.auth!.user;
  if (!(await confirmPassword(req, res, req.body?.password))) return;
  const existing = await db.query<{ id: string; transports: string | null }>("SELECT id, transports FROM webauthn_credentials WHERE user_id = $1", [me.id]);
  if (existing.length >= 10) return void res.status(409).json({ error: "Limite de 10 passkeys. Remova alguma." });
  const { rpID } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: "Ethos",
    rpID,
    userName: me.email,
    userDisplayName: me.name,
    userID: new TextEncoder().encode(String(me.id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  res.json({ options, token: await saveChallenge("register", options.challenge, me.id) });
});

passkeysRouter.post("/profile/passkeys/verify", async (req, res) => {
  const me = req.auth!.user;
  const ch = await takeChallenge(req.body?.token, "register");
  if (!ch || ch.user_id !== me.id) return void res.status(400).json({ error: "A operação expirou. Tente de novo." });
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : "Minha passkey";
  const { origin, rpID } = relyingParty(req);
  try {
    const v = await verifyRegistrationResponse({ response: req.body.response as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!v.verified || !v.registrationInfo) return void res.status(400).json({ error: "Não foi possível validar a passkey." });
    const c = v.registrationInfo.credential;
    await db.query("INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, name) VALUES ($1, $2, $3, $4, $5, $6)", [
      c.id, me.id, Buffer.from(c.publicKey), c.counter, (c.transports ?? []).join(","), name,
    ]);
    res.status(201).json({ id: c.id, name });
  } catch {
    res.status(400).json({ error: "Não foi possível validar a passkey." });
  }
});

passkeysRouter.delete("/profile/passkeys/:id", async (req, res) => {
  if (!(await confirmPassword(req, res, req.body?.password))) return;
  const done = await db.query("DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id", [String(req.params.id), req.auth!.user.id]);
  if (done.length === 0) return void res.status(404).json({ error: "Não encontrada." });
  res.status(204).end();
});

// ------------------------------------------------------------------ Entrar com passkey (público)

passkeysRouter.post("/auth/passkey/options", async (req, res) => {
  if (!(await limiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  let allow: { id: string }[] | undefined;
  let userId: number | null = null;
  if (email) {
    const rows = await db.query<{ id: string; user_id: number }>(
      "SELECT c.id, c.user_id FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = $1 AND u.deleted_at IS NULL",
      [email],
    );
    allow = rows.map((r) => ({ id: r.id }));
    userId = rows[0]?.user_id ?? null;
  }
  const { rpID } = relyingParty(req);
  // Sem e-mail (ou sem passkeys cadastradas): pede qualquer credencial descobrível, sem revelar se o e-mail existe.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred", allowCredentials: allow && allow.length ? allow : undefined });
  res.json({ options, token: await saveChallenge("login", options.challenge, userId) });
});

passkeysRouter.post("/auth/passkey/verify", async (req, res) => {
  if (!(await limiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const ch = await takeChallenge(req.body?.token, "login");
  const response = req.body?.response as AuthenticationResponseJSON | undefined;
  if (!ch || !response || typeof response.id !== "string") return void res.status(401).json({ error: "A verificação expirou. Tente de novo." });
  const [cred] = await db.query<{ id: string; user_id: number; public_key: Uint8Array; counter: string; transports: string | null }>(
    "SELECT id, user_id, public_key, counter, transports FROM webauthn_credentials WHERE id = $1",
    [response.id],
  );
  if (!cred || (ch.user_id && ch.user_id !== cred.user_id)) return void res.status(401).json({ error: "Passkey não reconhecida." });
  const { origin, rpID } = relyingParty(req);
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.counter), transports: (cred.transports ? cred.transports.split(",") : undefined) as never },
    });
    if (!v.verified) return void res.status(401).json({ error: "Passkey não reconhecida." });
    await db.query("UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1", [cred.id, v.authenticationInfo.newCounter]);
  } catch {
    return void res.status(401).json({ error: "Passkey não reconhecida." });
  }
  await finishLogin(req, res, cred.user_id, { viaPasskey: true });
});

// ------------------------------------------------------------------ Login social (Google/Microsoft via Supabase)

const PROVIDERS = () => (process.env.OAUTH_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter((p) => ["google", "azure"].includes(p));

/** Quais botões de login social mostrar (configurados em OAUTH_PROVIDERS e no Supabase). */
passkeysRouter.get("/auth/providers", (_req, res) => {
  res.json({ providers: PROVIDERS(), authorize_url: process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/authorize` : null, redirect_to: `${appUrl()}/` });
});

passkeysRouter.post("/auth/oauth", async (req, res) => {
  const token = req.body?.accessToken;
  if (typeof token !== "string" || !token) return void res.status(400).json({ error: "Dados inválidos" });
  if (!(await oauthLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
  const owner = await getAuthProvider().userFromRecoveryToken(token);
  if (!owner) return void res.status(401).json({ error: "Login social inválido ou expirado." });
  const [user] = await db.query<{ id: number }>("SELECT id FROM users WHERE auth_id = $1 AND deleted_at IS NULL", [owner.id]);
  if (!user) return void res.status(403).json({ error: "Não há conta do Ethos para este e-mail. Peça um convite à administradora." });
  await finishLogin(req, res, user.id, { viaPasskey: false });
});
