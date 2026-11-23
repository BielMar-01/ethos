import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { db, transaction, isUniqueViolation, type Role } from "./db.js";
import { createSession, currentSessionId, destroySession, loadAuth, requireAuth, requireRole } from "./auth.js";
import { AuthProviderError, appUrl, getAuthProvider } from "./authProvider.js";
import { crudRouter, parseId, type Field } from "./crud.js";
import { RateLimiter } from "./ratelimit.js";
import { teamRouter } from "./team.js";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const PROPERTY_TYPES = ["casa", "apartamento", "terreno", "comercial", "outro"] as const;
const UNIT_STATUS = ["disponivel", "ocupada", "manutencao"] as const;

const personFields: Field[] = [
  { name: "name", kind: "string", required: true },
  { name: "document", kind: "string", required: true, max: 20 },
  { name: "email", kind: "string", email: true },
  { name: "phone", kind: "string", max: 30 },
];

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(loadAuth);

  // Limites contra força bruta e abuso de e-mails (em memória, por instância).
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const forgotLimiter = new RateLimiter(5, 60 * 60 * 1000);
  const registerLimiter = new RateLimiter(Number(process.env.REGISTER_RATE_MAX ?? 10), 60 * 60 * 1000);
  const resetLimiter = new RateLimiter(10, 15 * 60 * 1000);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "ethos" });
  });

  // ---------- Autenticação ----------
  app.post("/api/auth/register", async (req, res) => {
    const { name, email, password, organizationName } = req.body ?? {};
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    if (
      !name.trim() ||
      !/^\S+@\S+\.\S+$/.test(cleanEmail) ||
      cleanEmail.length > 200 ||
      password.length < MIN_PASSWORD ||
      password.length > MAX_PASSWORD
    ) {
      res.status(400).json({ error: "Informe nome, e-mail válido e senha com 8+ caracteres" });
      return;
    }
    if (!registerLimiter.allow(`register:${req.ip}`)) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
      return;
    }
    const orgName =
      typeof organizationName === "string" && organizationName.trim()
        ? organizationName.trim().slice(0, 200)
        : name.trim();
    const provider = getAuthProvider();
    // Cadastro público cria uma nova organização e o usuário vira seu administrador.
    let authId: string | undefined;
    let created: { userId: number; orgId: number };
    try {
      authId = (await provider.createUser(cleanEmail, password)).id;
      created = await transaction(async (tx) => {
        const [org] = await tx.query<{ id: number }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
          orgName,
        ]);
        const [user] = await tx.query<{ id: number }>(
          "INSERT INTO users (name, email, auth_id) VALUES ($1, $2, $3) RETURNING id",
          [name.trim().slice(0, 200), cleanEmail, authId],
        );
        await tx.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [
          org!.id,
          user!.id,
        ]);
        return { userId: user!.id, orgId: org!.id };
      });
    } catch (err) {
      // Evita deixar uma credencial órfã no Supabase se o banco falhar.
      if (authId) await provider.deleteUser(authId).catch(() => {});
      if (isUniqueViolation(err) || (err instanceof AuthProviderError && err.code === "exists")) {
        res.status(409).json({ error: "E-mail já cadastrado" });
        return;
      }
      if (err instanceof AuthProviderError && err.code === "weak_password") {
        res.status(400).json({ error: "Senha fraca demais. Escolha outra." });
        return;
      }
      throw err;
    }
    await createSession(res, created.userId, created.orgId);
    res.status(201).json({
      user: { id: created.userId, name: name.trim(), email: cleanEmail },
      organization: { id: created.orgId, name: orgName },
      role: "admin" satisfies Role,
    });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const limitKey = `login:${req.ip}:${cleanEmail}`;
    if (!loginLimiter.allow(limitKey)) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
      return;
    }
    const [user] = await db.query<{ id: number; name: string; email: string; auth_id: string }>(
      "SELECT id, name, email, auth_id FROM users WHERE email = $1",
      [cleanEmail],
    );
    const verified = user ? await getAuthProvider().verifyCredentials(cleanEmail, password) : null;
    if (!user || !verified || verified.id !== user.auth_id) {
      res.status(401).json({ error: "E-mail ou senha incorretos" });
      return;
    }
    loginLimiter.reset(limitKey);
    const [membership] = await db.query<{ id: number; name: string; role: Role }>(
      `SELECT o.id, o.name, m.role FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 ORDER BY m.id LIMIT 1`,
      [user.id],
    );
    if (!membership) {
      res.status(403).json({ error: "Usuário sem organização" });
      return;
    }
    await createSession(res, user.id, membership.id);
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      organization: { id: membership.id, name: membership.name },
      role: membership.role,
    });
  });

  app.post("/api/auth/logout", async (req, res) => {
    await destroySession(req, res);
    res.status(204).end();
  });

  app.get("/api/auth/me", (req, res) => {
    res.json(req.auth ?? { user: null });
  });

  // Recuperação de senha: o Supabase envia o e-mail com um link para o app.
  // Resposta sempre 204 para não revelar quais e-mails existem.
  app.post("/api/auth/forgot", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) {
      res.status(400).json({ error: "Informe um e-mail válido" });
      return;
    }
    if (forgotLimiter.allow(`forgot:${req.ip}:${email}`)) {
      const known = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
      if (known.length > 0) {
        try {
          await getAuthProvider().sendRecovery(email, `${appUrl()}/`);
        } catch (err) {
          console.error("Falha ao enviar recuperação:", err instanceof Error ? err.message : err);
        }
      }
    }
    res.status(204).end();
  });

  // Define a nova senha usando o access_token do link de recuperação.
  app.post("/api/auth/reset", async (req, res) => {
    const { accessToken, password } = req.body ?? {};
    if (typeof accessToken !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      res.status(400).json({ error: "A senha deve ter 8+ caracteres" });
      return;
    }
    if (!resetLimiter.allow(`reset:${req.ip}`)) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
      return;
    }
    const provider = getAuthProvider();
    const owner = await provider.userFromRecoveryToken(accessToken);
    if (!owner) {
      res.status(400).json({ error: "Link inválido ou expirado. Solicite uma nova recuperação." });
      return;
    }
    try {
      await provider.setPassword(owner.id, password);
    } catch (err) {
      if (err instanceof AuthProviderError && err.code === "weak_password") {
        res.status(400).json({ error: "Senha fraca demais. Escolha outra." });
        return;
      }
      throw err;
    }
    // Quem trocou a senha por recuperação provavelmente perdeu o controle: derruba todas as sessões.
    await db.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE auth_id = $1)", [owner.id]);
    res.status(204).end();
  });

  // ---------- Organizações do usuário ----------
  app.get("/api/auth/organizations", requireAuth, async (req, res) => {
    const organizations = await db.query(
      `SELECT o.id, o.name, m.role FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 ORDER BY o.name`,
      [req.auth!.user.id],
    );
    res.json({ organizations });
  });

  app.post("/api/auth/switch", requireAuth, async (req, res) => {
    const organizationId = parseId(req.body?.organizationId);
    const [member] = organizationId
      ? await db.query("SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2", [
          req.auth!.user.id,
          organizationId,
        ])
      : [];
    if (!member) {
      res.status(403).json({ error: "Sem acesso a esta organização" });
      return;
    }
    await db.query("UPDATE sessions SET organization_id = $1 WHERE id = $2", [organizationId, currentSessionId(req)]);
    res.status(204).end();
  });

  // ---------- Equipe: membros, convites e redefinição pelo admin ----------
  app.use("/api", teamRouter);

  // ---------- Domínio ----------
  app.use("/api/owners", crudRouter({ table: "owners", fields: personFields, orderBy: "name" }));
  app.use("/api/tenants", crudRouter({ table: "tenants", fields: personFields, orderBy: "name" }));

  app.use(
    "/api/properties",
    crudRouter({
      table: "properties",
      orderBy: "name",
      fields: [
        { name: "name", kind: "string", required: true },
        { name: "type", kind: "enum", values: PROPERTY_TYPES, required: true },
        { name: "street", kind: "string" },
        { name: "number", kind: "string", max: 20 },
        { name: "complement", kind: "string" },
        { name: "neighborhood", kind: "string" },
        { name: "city", kind: "string" },
        { name: "state", kind: "string", max: 2 },
        { name: "zip", kind: "string", max: 10 },
      ],
    }),
  );

  // Proprietários de um imóvel (N:N). Ambos precisam ser da organização da sessão.
  app.put("/api/properties/:id/owners", requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
    const orgId = req.auth!.organization.id;
    const propertyId = parseId(req.params.id);
    const ownerIds: unknown = req.body?.ownerIds;
    if (!Array.isArray(ownerIds) || !ownerIds.every((n) => parseId(n) !== undefined)) {
      res.status(400).json({ error: "ownerIds deve ser uma lista de inteiros" });
      return;
    }
    const property = propertyId
      ? await db.query("SELECT 1 FROM properties WHERE id = $1 AND organization_id = $2", [propertyId, orgId])
      : [];
    if (property.length === 0) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    const unique = [...new Set(ownerIds as number[])];
    const found = await db.query<{ id: number }>(
      "SELECT id FROM owners WHERE organization_id = $1 AND id = ANY($2::int[])",
      [orgId, unique],
    );
    if (found.length !== unique.length) {
      res.status(400).json({ error: "Proprietário inexistente" });
      return;
    }
    await transaction(async (tx) => {
      await tx.query("DELETE FROM property_owners WHERE property_id = $1", [propertyId]);
      for (const ownerId of unique) {
        await tx.query("INSERT INTO property_owners (property_id, owner_id) VALUES ($1, $2)", [propertyId, ownerId]);
      }
    });
    res.json({ ownerIds: unique });
  });

  app.get("/api/properties/:id/owners", requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
    const propertyId = parseId(req.params.id);
    const items = propertyId
      ? await db.query(
          `SELECT o.* FROM property_owners po
           JOIN owners o ON o.id = po.owner_id
           JOIN properties p ON p.id = po.property_id
           WHERE po.property_id = $1 AND p.organization_id = $2`,
          [propertyId, req.auth!.organization.id],
        )
      : [];
    res.json({ items });
  });

  app.use(
    "/api/units",
    crudRouter({
      table: "units",
      orderBy: "property_id, identifier",
      fields: [
        { name: "property_id", kind: "ref", table: "properties", required: true },
        { name: "identifier", kind: "string", required: true, max: 50 },
        { name: "area_m2", kind: "int" },
        { name: "bedrooms", kind: "int" },
        { name: "rent_reference_cents", kind: "int" },
        { name: "status", kind: "enum", values: UNIT_STATUS },
      ],
    }),
  );

  // Rotas /api desconhecidas devolvem JSON, não o index.html do front.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Rota não encontrada" });
  });

  // Em produção serve o front-end compilado (client/dist).
  const clientDist = path.join(process.cwd(), "client", "dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "JSON inválido" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  };
  app.use(onError);

  return app;
}
