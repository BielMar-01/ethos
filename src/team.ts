import crypto from "node:crypto";
import { Router } from "express";
import { db, transaction, ROLES, isUniqueViolation, type Role } from "./db.js";
import { createSession, requireAuth, requireRole } from "./auth.js";
import { AuthProviderError, appUrl, getAuthProvider } from "./authProvider.js";
import { parseId } from "./crud.js";
import { RateLimiter } from "./ratelimit.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const acceptLimiter = new RateLimiter(Number(process.env.ACCEPT_RATE_MAX ?? 20), 15 * 60 * 1000);
const resetLimiter = new RateLimiter(10, 60 * 60 * 1000);

export const teamRouter = Router();
const adminOnly = [requireAuth, requireRole("admin")];

// ------------------------------------------------------------------ Membros

teamRouter.get("/members", ...adminOnly, async (req, res) => {
  const members = await db.query(
    `SELECT u.id, u.name, u.email, m.role, m.tenant_id, m.owner_id,
            COALESCE(t.name, o.name) AS linked_name
     FROM organization_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN tenants t ON t.id = m.tenant_id
     LEFT JOIN owners o ON o.id = m.owner_id
     WHERE m.organization_id = $1 ORDER BY u.id`,
    [req.auth!.organization.id],
  );
  res.json({ members });
});

/**
 * Papéis da área do cliente só enxergam dados pelo vínculo com o cadastro:
 * inquilino → tenantId, proprietário → ownerId (ambos da MESMA organização).
 */
async function resolveLink(
  orgId: number,
  role: Role,
  body: { tenantId?: unknown; ownerId?: unknown },
): Promise<{ tenantId: number | null; ownerId: number | null } | { error: string }> {
  if (role === "inquilino") {
    const id = parseId(body.tenantId);
    const found = id ? await db.query("SELECT 1 FROM tenants WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
    return found.length ? { tenantId: id!, ownerId: null } : { error: "Para o papel inquilino, informe tenantId (cadastro de inquilino da organização)" };
  }
  if (role === "proprietario") {
    const id = parseId(body.ownerId);
    const found = id ? await db.query("SELECT 1 FROM owners WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
    return found.length ? { tenantId: null, ownerId: id! } : { error: "Para o papel proprietário, informe ownerId (cadastro de proprietário da organização)" };
  }
  return { tenantId: null, ownerId: null };
}

/** Quantos administradores a organização tem (para nunca ficar sem nenhum). */
async function adminCount(orgId: number): Promise<number> {
  const [row] = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM organization_members WHERE organization_id = $1 AND role = 'admin'",
    [orgId],
  );
  return Number(row!.n);
}

teamRouter.patch("/members/:userId", ...adminOnly, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const userId = parseId(req.params.userId);
  const role = req.body?.role;
  if (typeof role !== "string" || !ROLES.includes(role as Role)) {
    res.status(400).json({ error: "Papel inválido" });
    return;
  }
  const [member] = userId
    ? await db.query<{ role: Role }>("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2", [
        orgId,
        userId,
      ])
    : [];
  if (!member) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (member.role === "admin" && role !== "admin" && (await adminCount(orgId)) <= 1) {
    res.status(409).json({ error: "A organização precisa ter pelo menos um administrador" });
    return;
  }
  const link = await resolveLink(orgId, role as Role, req.body ?? {});
  if ("error" in link) {
    res.status(400).json({ error: link.error });
    return;
  }
  // Ao mudar o papel o vínculo anterior é substituído (a restrição do banco exige coerência).
  await db.query(
    "UPDATE organization_members SET role = $1, tenant_id = $4, owner_id = $5 WHERE organization_id = $2 AND user_id = $3",
    [role, orgId, userId, link.tenantId, link.ownerId],
  );
  res.json({ id: userId, role });
});

teamRouter.delete("/members/:userId", ...adminOnly, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const userId = parseId(req.params.userId);
  const [member] = userId
    ? await db.query<{ role: Role }>("SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2", [
        orgId,
        userId,
      ])
    : [];
  if (!member) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (member.role === "admin" && (await adminCount(orgId)) <= 1) {
    res.status(409).json({ error: "A organização precisa ter pelo menos um administrador" });
    return;
  }
  await transaction(async (tx) => {
    await tx.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [orgId, userId]);
    // Encerra as sessões do usuário nesta organização.
    await tx.query("DELETE FROM sessions WHERE organization_id = $1 AND user_id = $2", [orgId, userId]);
  });
  res.status(204).end();
});

/**
 * Recuperação de senha disparada pelo administrador.
 *  - mode "email": o Supabase envia o e-mail de recuperação ao usuário.
 *  - mode "link": devolve o link ao admin (para entregar por outro canal). Como quem
 *    tiver o link controla a conta, só é permitido quando o usuário pertence APENAS
 *    a esta organização.
 */
teamRouter.post("/members/:userId/password-reset", ...adminOnly, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const userId = parseId(req.params.userId);
  const mode = req.body?.mode;
  if (mode !== "email" && mode !== "link") {
    res.status(400).json({ error: "mode deve ser 'email' ou 'link'" });
    return;
  }
  const [member] = userId
    ? await db.query<{ email: string; orgs: string }>(
        `SELECT u.email,
                (SELECT count(*) FROM organization_members x WHERE x.user_id = u.id)::text AS orgs
         FROM organization_members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = $1 AND m.user_id = $2`,
        [orgId, userId],
      )
    : [];
  if (!member) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (!resetLimiter.allow(`org:${orgId}`)) {
    res.status(429).json({ error: "Muitas redefinições. Tente novamente mais tarde." });
    return;
  }
  const redirectTo = `${appUrl()}/`;
  try {
    if (mode === "email") {
      await getAuthProvider().sendRecovery(member.email, redirectTo);
      res.json({ sent: true });
      return;
    }
    if (Number(member.orgs) > 1) {
      res.status(409).json({
        error: "Este usuário pertence a outras organizações. Envie a redefinição por e-mail.",
      });
      return;
    }
    const link = await getAuthProvider().generateRecoveryLink(member.email, redirectTo);
    res.json({ link });
  } catch (err) {
    if (err instanceof AuthProviderError && err.code === "rate_limited") {
      res.status(429).json({ error: "Limite de e-mails do provedor atingido. Gere o link ou tente mais tarde." });
      return;
    }
    throw err;
  }
});

// ------------------------------------------------------------------ Convites (admin)

teamRouter.get("/invitations", ...adminOnly, async (req, res) => {
  const invitations = await db.query(
    `SELECT id, email, role, expires_at, created_at, tenant_id, owner_id FROM invitations
     WHERE organization_id = $1 AND accepted_at IS NULL ORDER BY id DESC`,
    [req.auth!.organization.id],
  );
  res.json({ invitations });
});

teamRouter.post("/invitations", ...adminOnly, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const role = req.body?.role;
  if (!EMAIL_RE.test(email) || email.length > 200 || typeof role !== "string" || !ROLES.includes(role as Role)) {
    res.status(400).json({ error: "Informe e-mail válido e papel" });
    return;
  }
  const link = await resolveLink(orgId, role as Role, req.body ?? {});
  if ("error" in link) {
    res.status(400).json({ error: link.error });
    return;
  }
  const already = await db.query(
    `SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND u.email = $2`,
    [orgId, email],
  );
  if (already.length > 0) {
    res.status(409).json({ error: "Este e-mail já é membro da organização" });
    return;
  }
  const token = crypto.randomBytes(32).toString("base64url");
  // Reenviar um convite substitui o pendente anterior (que deixa de funcionar).
  const [invitation] = await transaction(async (tx) => {
    await tx.query("DELETE FROM invitations WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL", [
      orgId,
      email,
    ]);
    return tx.query(
      `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at, tenant_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, email, role, expires_at, created_at, tenant_id, owner_id`,
      [orgId, email, role, hashToken(token), req.auth!.user.id, new Date(Date.now() + INVITE_TTL_MS), link.tenantId, link.ownerId],
    );
  });
  res.status(201).json({ invitation, link: `${appUrl()}/?invite=${token}` });
});

teamRouter.delete("/invitations/:id", ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  const deleted = id
    ? await db.query(
        "DELETE FROM invitations WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL RETURNING id",
        [id, req.auth!.organization.id],
      )
    : [];
  if (deleted.length === 0) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  res.status(204).end();
});

// ------------------------------------------------------------------ Convites (público)

interface InviteRow {
  id: number;
  organization_id: number;
  organization_name: string;
  email: string;
  role: Role;
  tenant_id: number | null;
  owner_id: number | null;
}

async function findInvite(token: string): Promise<InviteRow | undefined> {
  const [row] = await db.query<InviteRow>(
    `SELECT i.id, i.organization_id, o.name AS organization_name, i.email, i.role, i.tenant_id, i.owner_id
     FROM invitations i JOIN organizations o ON o.id = i.organization_id
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
    [hashToken(token)],
  );
  return row;
}

teamRouter.get("/invitations/by-token/:token", async (req, res) => {
  if (!acceptLimiter.allow(`view:${req.ip}`)) {
    res.status(429).json({ error: "Muitas tentativas" });
    return;
  }
  const invite = await findInvite(req.params.token as string);
  if (!invite) {
    res.status(404).json({ error: "Convite inválido ou expirado" });
    return;
  }
  const existing = await db.query("SELECT 1 FROM users WHERE email = $1", [invite.email]);
  res.json({
    email: invite.email,
    role: invite.role,
    organizationName: invite.organization_name,
    existingAccount: existing.length > 0,
  });
});

teamRouter.post("/invitations/by-token/:token/accept", async (req, res) => {
  if (!acceptLimiter.allow(`accept:${req.ip}`)) {
    res.status(429).json({ error: "Muitas tentativas" });
    return;
  }
  const invite = await findInvite(req.params.token as string);
  if (!invite) {
    res.status(404).json({ error: "Convite inválido ou expirado" });
    return;
  }
  const { name, password } = req.body ?? {};
  if (typeof password !== "string" || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Informe uma senha com 8+ caracteres" });
    return;
  }
  const provider = getAuthProvider();
  const [existing] = await db.query<{ id: number; name: string; auth_id: string }>(
    "SELECT id, name, auth_id FROM users WHERE email = $1",
    [invite.email],
  );

  let userId: number;
  let userName: string;
  let createdAuthId: string | undefined;
  try {
    if (existing) {
      // Conta já existe: a senha comprova que quem aceita é o dono do e-mail.
      const ok = await provider.verifyCredentials(invite.email, password);
      if (!ok || ok.id !== existing.auth_id) {
        res.status(401).json({ error: "Senha incorreta para a conta existente" });
        return;
      }
      userId = existing.id;
      userName = existing.name;
    } else {
      if (typeof name !== "string" || !name.trim()) {
        res.status(400).json({ error: "Informe seu nome" });
        return;
      }
      userName = name.trim().slice(0, 200);
      createdAuthId = (await provider.createUser(invite.email, password)).id;
    }

    userId = await transaction(async (tx) => {
      // O UPDATE condicional garante uso único mesmo com aceites simultâneos.
      const claimed = await tx.query(
        "UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING id",
        [invite.id],
      );
      if (claimed.length === 0) throw new AuthProviderError("exists", "convite já utilizado");
      let uid = existing?.id;
      if (uid === undefined) {
        const [u] = await tx.query<{ id: number }>(
          "INSERT INTO users (name, email, auth_id) VALUES ($1, $2, $3) RETURNING id",
          [userName, invite.email, createdAuthId],
        );
        uid = u!.id;
      }
      await tx.query(
        "INSERT INTO organization_members (organization_id, user_id, role, tenant_id, owner_id) VALUES ($1, $2, $3, $4, $5)",
        [invite.organization_id, uid, invite.role, invite.tenant_id, invite.owner_id],
      );
      return uid;
    });
  } catch (err) {
    if (createdAuthId) await provider.deleteUser(createdAuthId).catch(() => {});
    if (err instanceof AuthProviderError && err.code === "weak_password") {
      res.status(400).json({ error: "Senha fraca demais. Escolha outra." });
      return;
    }
    if (err instanceof AuthProviderError && err.code === "exists") {
      res.status(409).json({ error: "Convite já utilizado ou e-mail já cadastrado" });
      return;
    }
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "Este usuário já pertence à organização" });
      return;
    }
    throw err;
  }

  await createSession(res, userId, invite.organization_id);
  res.status(201).json({
    user: { id: userId, name: userName, email: invite.email },
    organization: { id: invite.organization_id, name: invite.organization_name },
    role: invite.role,
  });
});
