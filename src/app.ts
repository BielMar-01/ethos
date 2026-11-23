import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import fs from "node:fs";
import { db, transaction, isUniqueViolation, type Role } from "./db.js";
import {
  createSession,
  destroySession,
  hashPassword,
  loadAuth,
  requireAuth,
  requireRole,
  verifyPassword,
} from "./auth.js";
import { crudRouter, parseId, type Field } from "./crud.js";

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
    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(cleanEmail) || password.length < 8 || password.length > 200) {
      res.status(400).json({ error: "Informe nome, e-mail válido e senha com 8+ caracteres" });
      return;
    }
    const orgName =
      typeof organizationName === "string" && organizationName.trim()
        ? organizationName.trim().slice(0, 200)
        : name.trim();
    // Cadastro público cria uma nova organização e o usuário vira seu administrador.
    let created: { userId: number; orgId: number };
    try {
      created = await transaction(async (tx) => {
        const [org] = await tx.query<{ id: number }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [
          orgName,
        ]);
        const [user] = await tx.query<{ id: number }>(
          "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [name.trim(), cleanEmail, hashPassword(password)],
        );
        await tx.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [
          org!.id,
          user!.id,
        ]);
        return { userId: user!.id, orgId: org!.id };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: "E-mail já cadastrado" });
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
    const [user] = await db.query<{ id: number; name: string; email: string; password_hash: string }>(
      "SELECT id, name, email, password_hash FROM users WHERE email = $1",
      [email.trim().toLowerCase()],
    );
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "E-mail ou senha incorretos" });
      return;
    }
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

  // ---------- Organização ----------
  app.get("/api/members", requireAuth, requireRole("admin"), async (req, res) => {
    const members = await db.query(
      `SELECT u.id, u.name, u.email, m.role FROM organization_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 ORDER BY u.id`,
      [req.auth!.organization.id],
    );
    res.json({ members });
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
