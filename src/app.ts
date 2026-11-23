import express from "express";
import path from "node:path";
import fs from "node:fs";
import { db, transaction, type Role } from "./db.js";
import {
  createSession,
  destroySession,
  hashPassword,
  loadAuth,
  requireAuth,
  requireRole,
  verifyPassword,
} from "./auth.js";
import { crudRouter, type Field } from "./crud.js";

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
  app.post("/api/auth/register", (req, res) => {
    const { name, email, password, organizationName } = req.body ?? {};
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(cleanEmail) || password.length < 8) {
      res.status(400).json({ error: "Informe nome, e-mail válido e senha com 8+ caracteres" });
      return;
    }
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(cleanEmail)) {
      res.status(409).json({ error: "E-mail já cadastrado" });
      return;
    }
    const orgName =
      typeof organizationName === "string" && organizationName.trim() ? organizationName.trim() : name.trim();
    // Cadastro público cria uma nova organização e o usuário vira seu administrador.
    const { userId, orgId } = transaction(() => {
      const org = db.prepare("INSERT INTO organizations (name) VALUES (?)").run(orgName);
      const user = db
        .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
        .run(name.trim(), cleanEmail, hashPassword(password));
      const orgId = Number(org.lastInsertRowid);
      const userId = Number(user.lastInsertRowid);
      db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'admin')").run(
        orgId,
        userId,
      );
      return { userId, orgId };
    });
    createSession(res, userId, orgId);
    res.status(201).json({
      user: { id: userId, name: name.trim(), email: cleanEmail },
      organization: { id: orgId, name: orgName },
      role: "admin" satisfies Role,
    });
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "Dados inválidos" });
      return;
    }
    const user = db
      .prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?")
      .get(email.trim().toLowerCase()) as unknown as
      | { id: number; name: string; email: string; password_hash: string }
      | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "E-mail ou senha incorretos" });
      return;
    }
    const membership = db
      .prepare(
        `SELECT o.id, o.name, m.role FROM organization_members m
         JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = ? ORDER BY m.id LIMIT 1`,
      )
      .get(user.id) as unknown as { id: number; name: string; role: Role } | undefined;
    if (!membership) {
      res.status(403).json({ error: "Usuário sem organização" });
      return;
    }
    createSession(res, user.id, membership.id);
    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      organization: { id: membership.id, name: membership.name },
      role: membership.role,
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    destroySession(req, res);
    res.status(204).end();
  });

  app.get("/api/auth/me", (req, res) => {
    res.json(req.auth ?? { user: null });
  });

  // ---------- Organização ----------
  app.get("/api/members", requireAuth, requireRole("admin"), (req, res) => {
    const members = db
      .prepare(
        `SELECT u.id, u.name, u.email, m.role FROM organization_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ? ORDER BY u.id`,
      )
      .all(req.auth!.organization.id);
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
  app.put("/api/properties/:id/owners", requireAuth, requireRole("admin", "colaborador"), (req, res) => {
    const orgId = req.auth!.organization.id;
    const propertyId = Number(req.params.id);
    const ownerIds: unknown = req.body?.ownerIds;
    if (!Array.isArray(ownerIds) || !ownerIds.every((n) => Number.isInteger(n))) {
      res.status(400).json({ error: "ownerIds deve ser uma lista de inteiros" });
      return;
    }
    if (!db.prepare("SELECT 1 FROM properties WHERE id = ? AND organization_id = ?").get(propertyId, orgId)) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    const unique = [...new Set(ownerIds as number[])];
    for (const ownerId of unique) {
      if (!db.prepare("SELECT 1 FROM owners WHERE id = ? AND organization_id = ?").get(ownerId, orgId)) {
        res.status(400).json({ error: "Proprietário inexistente" });
        return;
      }
    }
    transaction(() => {
      db.prepare("DELETE FROM property_owners WHERE property_id = ?").run(propertyId);
      for (const ownerId of unique) {
        db.prepare("INSERT INTO property_owners (property_id, owner_id) VALUES (?, ?)").run(propertyId, ownerId);
      }
    });
    res.json({ ownerIds: unique });
  });

  app.get("/api/properties/:id/owners", requireAuth, requireRole("admin", "colaborador"), (req, res) => {
    const rows = db
      .prepare(
        `SELECT o.* FROM property_owners po
         JOIN owners o ON o.id = po.owner_id
         JOIN properties p ON p.id = po.property_id
         WHERE po.property_id = ? AND p.organization_id = ?`,
      )
      .all(Number(req.params.id), req.auth!.organization.id);
    res.json({ items: rows });
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

  return app;
}
