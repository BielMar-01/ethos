import crypto from "node:crypto";
import { Router } from "express";
import { db, transaction, ROLES, isUniqueViolation, type Role } from "./db.js";
import { createSession, currentSessionId, requireAuth, requireRole } from "./auth.js";
import { AuthProviderError, appUrl, getAuthProvider } from "./authProvider.js";
import { parseId } from "./crud.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { passwordProblem } from "./security.js";
import { sendEmail } from "./mailer.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const generateTempPassword = (length = 14) =>
  Array.from({ length }, () => TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)]).join("");

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const acceptLimiter = new SharedRateLimiter("accept", Number(process.env.ACCEPT_RATE_MAX ?? 20), 15 * 60 * 1000);
const resetLimiter = new SharedRateLimiter("team-reset", 10, 60 * 60 * 1000);

const mailLimiter = new SharedRateLimiter("invite-mail", 30, 60 * 60 * 1000);
const ROLE_PT: Record<string, string> = { admin: "administrador(a)", colaborador: "colaborador(a)", proprietario: "proprietário(a)", inquilino: "inquilino(a)" };

/** E-mail do convite (texto simples). Nunca lança: devolve se foi enviado. */
async function mailInvite(org: string, inviter: string, to: string, role: Role, url: string, ttlMs: number): Promise<boolean> {
  const days = Math.round(ttlMs / 86_400_000);
  const text = [
    `Olá!`,
    ``,
    `${inviter} convidou você para acessar a ${org} no Ethos, como ${ROLE_PT[role] ?? role}.`,
    ``,
    `Para criar seu acesso (ou entrar, se já tem conta), abra o link abaixo. O e-mail ${to} já vem preenchido:`,
    url,
    ``,
    `O link vale por ${days} dias e só pode ser usado uma vez. Se você não esperava este convite, ignore esta mensagem: nada será criado.`,
  ].join("\n");
  return sendEmail({ to, subject: `Convite para acessar ${org} no Ethos`, text });
}

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
  if (mode !== "email" && mode !== "link" && mode !== "password") {
    res.status(400).json({ error: "mode deve ser 'email', 'link' ou 'password'" });
    return;
  }
  const [member] = userId
    ? await db.query<{ email: string; auth_id: string; orgs: string }>(
        `SELECT u.email, u.auth_id,
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
  if (!(await resetLimiter.allow(`org:${orgId}`))) {
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
    if (mode === "password") {
      // Define a senha direto: a que o admin digitou ou, se vier vazia, uma temporária (mostrada UMA vez).
      const typed = req.body?.password;
      const generated = typed === undefined || typed === null || typed === "";
      if (!generated && (typeof typed !== "string" || typed.length < 8 || typed.length > 200)) {
        res.status(400).json({ error: "A senha deve ter de 8 a 200 caracteres" });
        return;
      }
      const password = generated ? generateTempPassword() : (typed as string);
      if (!generated) {
        const weak = await passwordProblem(password, member.email);
        if (weak) {
          res.status(400).json({ error: weak });
          return;
        }
      }
      try {
        await getAuthProvider().setPassword(member.auth_id, password);
      } catch (err) {
        if (err instanceof AuthProviderError && err.code === "weak_password") {
          res.status(400).json({ error: "Senha fraca demais. Escolha outra." });
          return;
        }
        throw err;
      }
      // Derruba as sessões da pessoa (a do próprio admin, se for ele, continua).
      await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, currentSessionId(req) ?? ""]);
      res.json({ changed: true, ...(generated ? { password } : {}) });
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

/**
 * Perdeu o celular e os códigos de recuperação: o admin desativa o 2FA da pessoa (ela entra só com a senha e configura de novo).
 * Só para quem pertence apenas a esta organização, para um admin nunca mexer na segurança de contas de outras organizações.
 */
teamRouter.post("/members/:userId/mfa-reset", ...adminOnly, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const userId = parseId(req.params.userId);
  const [member] = userId
    ? await db.query<{ orgs: string }>(
        `SELECT (SELECT count(*) FROM organization_members x WHERE x.user_id = m.user_id)::text AS orgs
         FROM organization_members m WHERE m.organization_id = $1 AND m.user_id = $2`,
        [orgId, userId],
      )
    : [];
  if (!member) return void res.status(404).json({ error: "Não encontrado" });
  if (Number(member.orgs) > 1) return void res.status(409).json({ error: "Este usuário pertence a outras organizações. Ele mesmo deve desativar o 2FA." });
  await transaction(async (tx) => {
    await tx.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
    await tx.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
    await tx.query("DELETE FROM mfa_challenges WHERE user_id = $1", [userId]);
    await tx.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, currentSessionId(req) ?? ""]);
  });
  res.status(204).end();
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
  const sendMail = req.body?.send_email !== false;
  if (sendMail && !(await mailLimiter.allow(`org:${orgId}`))) {
    res.status(429).json({ error: "Muitos convites enviados por e-mail. Desmarque o envio e copie o link, ou tente mais tarde." });
    return;
  }
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
  const url = `${appUrl()}/?invite=${token}`;
  const email_sent = sendMail ? await mailInvite(req.auth!.organization.name, req.auth!.user.name, email, role as Role, url, INVITE_TTL_MS) : false;
  res.status(201).json({ invitation, link: url, email_sent });
});

/**
 * Reenvia um convite pendente: como só o hash do token é guardado, gera um link NOVO (o anterior deixa de valer) e renova a validade.
 * `send_email` (padrão true) manda o e-mail; com false só devolve o link para copiar.
 */
teamRouter.post("/invitations/:id/resend", ...adminOnly, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const sendMail = req.body?.send_email !== false;
  const [inv] = id
    ? await db.query<{ email: string; role: Role }>("SELECT email, role FROM invitations WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL", [id, orgId])
    : [];
  if (!inv) return void res.status(404).json({ error: "Não encontrado" });
  if (sendMail && !(await mailLimiter.allow(`org:${orgId}`))) {
    return void res.status(429).json({ error: "Muitos convites enviados por e-mail. Copie o link ou tente mais tarde." });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const [updated] = await db.query<{ id: number; email: string; role: Role; expires_at: string; created_at: string; tenant_id: number | null; owner_id: number | null }>(
    `UPDATE invitations SET token_hash = $3, expires_at = $4 WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL
     RETURNING id, email, role, expires_at, created_at, tenant_id, owner_id`,
    [id, orgId, hashToken(token), new Date(Date.now() + INVITE_TTL_MS)],
  );
  if (!updated) return void res.status(404).json({ error: "Não encontrado" });
  const url = `${appUrl()}/?invite=${token}`;
  const email_sent = sendMail ? await mailInvite(req.auth!.organization.name, req.auth!.user.name, inv.email, inv.role, url, INVITE_TTL_MS) : false;
  res.json({ invitation: updated, link: url, email_sent });
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
  inviter_name: string | null;
}

async function findInvite(token: string): Promise<InviteRow | undefined> {
  const [row] = await db.query<InviteRow>(
    `SELECT i.id, i.organization_id, o.name AS organization_name, i.email, i.role, i.tenant_id, i.owner_id, u.name AS inviter_name
     FROM invitations i JOIN organizations o ON o.id = i.organization_id
     LEFT JOIN users u ON u.id = i.invited_by
     WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
    [hashToken(token)],
  );
  return row;
}

teamRouter.get("/invitations/by-token/:token", async (req, res) => {
  if (!(await acceptLimiter.allow(`view:${req.ip}`))) {
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
    inviterName: invite.inviter_name,
    existingAccount: existing.length > 0,
  });
});

teamRouter.post("/invitations/by-token/:token/accept", async (req, res) => {
  if (!(await acceptLimiter.allow(`accept:${req.ip}`))) {
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
      const weak = await passwordProblem(password, invite.email);
      if (weak) {
        res.status(400).json({ error: weak });
        return;
      }
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

  await createSession(res, userId, invite.organization_id, req);
  res.status(201).json({
    user: { id: userId, name: userName, email: invite.email },
    organization: { id: invite.organization_id, name: invite.organization_name },
    role: invite.role,
  });
});
