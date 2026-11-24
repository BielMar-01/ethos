import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { db, transaction, isUniqueViolation, type Role } from "./db.js";
import { createSession, currentSessionId, destroySession, loadAuth, requireAuth, requireRole } from "./auth.js";
import { AuthProviderError, appUrl, getAuthProvider } from "./authProvider.js";
import { crudRouter, parseId, type Field } from "./crud.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { csrfGuard } from "./csrf.js";
import { channelsRouter } from "./channels.js";
import { mfaRouter, startMfaChallenge, userHasMfa } from "./mfa.js";
import { passkeysRouter } from "./passkeys.js";
import "./jobs.js";
import { lateFeesRouter } from "./lateFees.js";
import { bankRouter } from "./bank.js";
import { rateioRouter } from "./rateio.js";
import { contracts2Router } from "./contracts2.js";
import { signaturesRouter } from "./signatures.js";
import { crmRouter } from "./crm.js";
import { propDocsRouter } from "./propdocs.js";
import { opsRouter } from "./ops.js";
import { captureServerError, monitoringRouter } from "./monitoring.js";
import { ownerReportsRouter, reportsRouter } from "./reports.js";
import { COUNTRY_BLOCKED_MESSAGE, countryAllowed, noteLogin, passwordProblem, securityRouter } from "./security.js";
import { teamRouter } from "./team.js";
import { contractsRouter } from "./contracts.js";
import { portalRouter } from "./portal.js";
import { portalExtraRouter } from "./portalExtra.js";
import { maintenanceRouter } from "./maintenance.js";
import { inspectionsRouter } from "./inspections.js";
import { photosRouter } from "./photos.js";
import { announcementsRouter, clientAnnouncementsRouter, notificationsRouter } from "./notifications.js";
import { remindersRouter } from "./reminders.js";
import { dashboardRouter } from "./dashboard.js";
import { apiKeysRouter } from "./apikeys.js";
import { buildOpenApi } from "./apiSpec.js";
import { financeRouter } from "./finance.js";
import { boletosRouter, tenantBoletosRouter } from "./boletos.js";
import { profileRouter } from "./profile.js";
import { householdRouter } from "./household.js";
import { household2Router } from "./household2.js";
import { importRouter } from "./importer.js";
import { cepRouter } from "./cep.js";
import { integrationsRouter } from "./integrations.js";
import { webhooksRouter } from "./webhooks.js";
import { extractRouter } from "./extract.js";
import { auditMiddleware, auditRouter, recordAudit, requestInfo } from "./audit.js";

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
  // Atrás de proxy (Vercel etc.) o IP real vem de X-Forwarded-For; sem isso, limites e auditoria veem só o IP do proxy.
  if (process.env.VERCEL || process.env.TRUST_PROXY) app.set("trust proxy", 1);
  // Cabeçalhos básicos de segurança (a CSP completa e o HSTS ficam em vercel.json / no proxy).
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  // A importação em massa tem o próprio limite de corpo (ver importer.ts); o resto da API aceita 100 KB.
  const smallJson = express.json({ limit: "100kb" });
  app.use((req, res, next) => (req.path === "/api/import" || req.path === "/api/bank/import" ? next() : smallJson(req, res, next)));
  app.use("/api", csrfGuard);
  app.use(loadAuth);
  // Leituras sensíveis que NÃO são oferecidas a chaves de API (dados pessoais/financeiros de terceiros, arquivos e evidências).
  const KEY_BLOCKED = [/^\/api\/credit-checks/, /^\/api\/bank\//, /^\/api\/visitors\/\d+\/photo/, /^\/api\/property-documents\/\d+\/file/, /^\/api\/documents\/\d+\/signature/, /^\/api\/settings\/public-listing/, /^\/api\/reports\/(owner-income|dimob)/];
  app.use("/api", (req, res, next) => {
    if (req.auth?.viaApiKey && KEY_BLOCKED.some((r) => r.test(req.originalUrl.split("?")[0]!))) return void res.status(403).json({ error: "Este recurso não está disponível para chaves de API." });
    next();
  });
  app.use(auditMiddleware);

  // Limites contra força bruta e abuso de e-mails. Ficam no banco: valem entre instâncias (Vercel).
  const loginLimiter = new SharedRateLimiter("login", 10, 15 * 60 * 1000);
  const forgotLimiter = new SharedRateLimiter("forgot", 5, 60 * 60 * 1000);
  const registerLimiter = new SharedRateLimiter("register", Number(process.env.REGISTER_RATE_MAX ?? 10), 60 * 60 * 1000);
  const resetLimiter = new SharedRateLimiter("reset", 10, 15 * 60 * 1000);
  const verifyLimiter = new SharedRateLimiter("verify", 5, 60 * 60 * 1000);
  const requireVerification = () => process.env.REQUIRE_EMAIL_VERIFICATION === "1";

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
    if (!(await registerLimiter.allow(`register:${req.ip}`))) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
      return;
    }
    const weak = await passwordProblem(password, cleanEmail);
    if (weak) {
      res.status(400).json({ error: weak });
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
      authId = (await provider.createUser(cleanEmail, password, { confirmed: !requireVerification() })).id;
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
    if (requireVerification()) {
      // E-mail ainda não confirmado: sem sessão até clicar no link (o Supabase recusa o login até lá).
      await provider.sendVerification(cleanEmail, `${appUrl()}/`).catch((err) => console.error("Falha ao enviar verificação:", err instanceof Error ? err.message : err));
      res.status(201).json({ verification_required: true, email: cleanEmail });
      return;
    }
    await createSession(res, created.userId, created.orgId, req);
    await noteLogin(req, created.userId, created.orgId);
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
    if (!(await loginLimiter.allow(limitKey))) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
      return;
    }
    type LoginUser = { id: number; name: string; email: string; auth_id: string };
    let [user]: (LoginUser | undefined)[] = await db.query<LoginUser>(
      "SELECT id, name, email, auth_id FROM users WHERE email = $1 AND deleted_at IS NULL",
      [cleanEmail],
    );
    let verified: { id: string } | null = null;
    try {
      verified = await getAuthProvider().verifyCredentials(cleanEmail, password);
    } catch (err) {
      if (err instanceof AuthProviderError && err.code === "unconfirmed") {
        res.status(403).json({ error: "Confirme o seu e-mail pelo link que enviamos antes de entrar.", code: "email_unconfirmed" });
        return;
      }
      throw err;
    }
    if (!user && verified) {
      // O e-mail mudou no provedor (link de troca confirmado) e o app ainda não sincronizou: alinha agora.
      [user] = await db.query<LoginUser>(
        "SELECT id, name, email, auth_id FROM users WHERE auth_id = $1 AND deleted_at IS NULL",
        [verified.id],
      );
      if (user) {
        const [pend] = await db.query<{ pending_email: string | null }>("SELECT pending_email FROM users WHERE id = $1", [user.id]);
        const taken = await db.query("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [cleanEmail, user.id]);
        if (pend?.pending_email === cleanEmail && taken.length === 0) {
          await db.query("UPDATE users SET email = $1, pending_email = NULL, pending_email_at = NULL WHERE id = $2", [cleanEmail, user.id]);
          user.email = cleanEmail;
        } else {
          // A troca foi cancelada no app (ou o e-mail ficou ocupado): desfaz no provedor e recusa.
          await getAuthProvider().setEmail(user.auth_id, user.email).catch(() => {});
          user = undefined;
        }
      }
    }
    if (!user || !verified || verified.id !== user.auth_id) {
      if (user) {
        // Registra a tentativa falha em cada organização do usuário (o admin enxerga só a sua).
        const orgs = await db.query<{ organization_id: number; role: string }>(
          "SELECT organization_id, role FROM organization_members WHERE user_id = $1",
          [user.id],
        );
        for (const o of orgs) {
          await recordAudit({
            organizationId: o.organization_id, userId: user.id, userName: user.name, userEmail: user.email, role: o.role,
            kind: "auth", entity: "auth", summary: "Tentativa de login com senha incorreta", status: 401, ...requestInfo(req),
          });
        }
      }
      res.status(401).json({ error: "E-mail ou senha incorretos" });
      return;
    }
    await loginLimiter.reset(limitKey);
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
    if (!(await countryAllowed(req, user.id))) {
      res.status(403).json({ error: COUNTRY_BLOCKED_MESSAGE });
      return;
    }
    if (await userHasMfa(user.id)) {
      // Senha certa, mas há segundo fator: ainda não é sessão. O navegador devolve o código em /api/auth/mfa.
      res.json({ mfa_required: true, mfa_token: await startMfaChallenge(user.id, membership.id) });
      return;
    }
    await createSession(res, user.id, membership.id, req);
    await noteLogin(req, user.id, membership.id);
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

  app.get("/api/auth/me", async (req, res) => {
    if (!req.auth) return void res.json({ user: null });
    if (req.auth.viaApiKey) return void res.json(req.auth);
    // O carimbo da foto de perfil deixa o menu mostrar a imagem e renovar o cache quando ela muda.
    const [a] = await db.query<{ v: number }>("SELECT (extract(epoch FROM updated_at) * 1000)::bigint::float8 AS v FROM user_avatars WHERE user_id = $1", [req.auth.user.id]);
    res.json({ ...req.auth, user: { ...req.auth.user, avatar_version: a?.v ?? null } });
  });

  // Recuperação de senha: o Supabase envia o e-mail com um link para o app.
  // Resposta sempre 204 para não revelar quais e-mails existem.
  app.post("/api/auth/forgot", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) {
      res.status(400).json({ error: "Informe um e-mail válido" });
      return;
    }
    if (await forgotLimiter.allow(`forgot:${req.ip}:${email}`)) {
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
    if (!(await resetLimiter.allow(`reset:${req.ip}`))) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
      return;
    }
    const provider = getAuthProvider();
    const owner = await provider.userFromRecoveryToken(accessToken);
    if (!owner) {
      res.status(400).json({ error: "Link inválido ou expirado. Solicite uma nova recuperação." });
      return;
    }
    const weak = await passwordProblem(password, owner.email);
    if (weak) {
      res.status(400).json({ error: weak });
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
    const who = await db.query<{ id: number; name: string; email: string; organization_id: number; role: string }>(
      `SELECT u.id, u.name, u.email, m.organization_id, m.role FROM users u
       JOIN organization_members m ON m.user_id = u.id WHERE u.auth_id = $1`,
      [owner.id],
    );
    for (const w of who) {
      await recordAudit({
        organizationId: w.organization_id, userId: w.id, userName: w.name, userEmail: w.email, role: w.role,
        kind: "auth", entity: "auth", summary: "Redefiniu a própria senha pelo link de recuperação", status: 204, ...requestInfo(req),
      });
    }
    res.status(204).end();
  });

  // Reenvio do link de verificação do cadastro. Sempre 204 (não revela se o e-mail existe).
  app.post("/api/auth/resend-verification", async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) {
      res.status(400).json({ error: "Informe um e-mail válido" });
      return;
    }
    if (requireVerification() && (await verifyLimiter.allow(`verify:${req.ip}:${email}`))) {
      const known = await db.query("SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL", [email]);
      if (known.length > 0) await getAuthProvider().sendVerification(email, `${appUrl()}/`).catch((err) => console.error("Falha ao reenviar verificação:", err instanceof Error ? err.message : err));
    }
    res.status(204).end();
  });

  // O link de confirmação de troca de e-mail volta ao app com um access_token: quem manda é o provedor,
  // então o e-mail DELE é a verdade. O app só espelha o que o provedor já confirmou.
  app.post("/api/auth/email-confirmed", async (req, res) => {
    const token = req.body?.accessToken;
    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    if (!(await resetLimiter.allow(`confirm:${req.ip}`))) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
      return;
    }
    const owner = await getAuthProvider().userFromRecoveryToken(token);
    if (!owner || !owner.email) {
      res.status(400).json({ error: "Link inválido ou expirado." });
      return;
    }
    const email = owner.email.toLowerCase();
    const [user] = await db.query<{ id: number; email: string }>("SELECT id, email FROM users WHERE auth_id = $1 AND deleted_at IS NULL", [owner.id]);
    if (user && user.email !== email) {
      const [pend] = await db.query<{ pending_email: string | null }>("SELECT pending_email FROM users WHERE id = $1", [user.id]);
      const taken = await db.query("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [email, user.id]);
      if (pend?.pending_email !== email || taken.length > 0) {
        // Troca cancelada no app (ou e-mail ocupado): o provedor volta ao e-mail do app.
        await getAuthProvider().setEmail(owner.id, user.email).catch(() => {});
        res.status(409).json({ error: "Este pedido de troca de e-mail foi cancelado ou não vale mais." });
        return;
      }
      await db.query("UPDATE users SET email = $1, pending_email = NULL, pending_email_at = NULL WHERE id = $2", [email, user.id]);
    } else if (user) {
      await db.query("UPDATE users SET pending_email = NULL, pending_email_at = NULL WHERE id = $1", [user.id]);
    }
    res.json({ email });
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

  // ---------- Contratos ----------
  app.use("/api", contractsRouter);

  // ---------- Financeiro ----------
  app.use("/api", financeRouter);
  app.use("/api", boletosRouter);
  app.use("/api", lateFeesRouter);
  app.use("/api", bankRouter);
  app.use("/api", rateioRouter);
  app.use("/api", contracts2Router);
  app.use("/api", signaturesRouter);
  app.use("/api", crmRouter);
  app.use("/api", propDocsRouter);
  app.use("/api", opsRouter);
  app.use("/api", monitoringRouter);
  app.use("/api", reportsRouter);
  app.use("/api", ownerReportsRouter);
  app.use("/api", tenantBoletosRouter);
  app.use("/api", mfaRouter);
  app.use("/api", channelsRouter);
  app.use("/api", passkeysRouter);
  app.use("/api", securityRouter);
  app.use("/api", profileRouter);
  app.use("/api", householdRouter);
  app.use("/api", household2Router);

  // ---------- Área do cliente, chaves de API e documentação ----------
  app.use("/api", maintenanceRouter);
  app.use("/api", inspectionsRouter);
  app.use("/api", photosRouter);
  app.use("/api", portalRouter);
  app.use("/api", portalExtraRouter);

  // ---------- Notificações, comunicados e lembretes ----------
  app.use("/api", notificationsRouter);
  app.use("/api", announcementsRouter);
  app.use("/api", clientAnnouncementsRouter);
  app.use("/api", remindersRouter);
  app.use("/api", dashboardRouter);
  app.use("/api", auditRouter);
  app.use("/api", importRouter);
  app.use("/api", cepRouter);
  app.use("/api", integrationsRouter);
  app.use("/api", webhooksRouter);
  app.use("/api", extractRouter);
  app.use("/api", apiKeysRouter);
  app.get("/api/openapi.json", (req, res) => {
    res.json(buildOpenApi(`${req.protocol}://${req.get("host")}`));
  });

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
    app.use(
      express.static(clientDist, {
        setHeaders(res, file) {
          const name = path.basename(file);
          // O service worker e o manifesto nunca podem ficar presos em cache; os arquivos com hash no nome, sim.
          if (name === "sw.js" || name === "manifest.webmanifest" || name === "index.html" || name === "offline.html") {
            res.setHeader("Cache-Control", "no-cache");
          } else if (file.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
          if (name === "sw.js") res.setHeader("Service-Worker-Allowed", "/");
        },
      }),
    );
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: "Arquivo ou corpo grande demais (fotos: até 3 MB)" });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "JSON inválido" });
      return;
    }
    console.error(err);
    void captureServerError(err, req);
    res.status(500).json({ error: "Erro interno" });
  };
  app.use(onError);

  return app;
}
