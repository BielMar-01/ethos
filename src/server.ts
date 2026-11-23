import express from "express";
import path from "node:path";
import fs from "node:fs";
import { db, type User } from "./db.js";
import {
  createSession,
  destroySession,
  hashPassword,
  loadUser,
  requireAuth,
  requireRole,
  verifyPassword,
} from "./auth.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(loadUser);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "ethos" });
});

app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body ?? {};
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
  // O primeiro usuário cadastrado vira administrador.
  const isFirst = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  const result = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
    .run(name.trim(), cleanEmail, hashPassword(password), isFirst ? "admin" : "user");
  const userId = Number(result.lastInsertRowid);
  createSession(res, userId);
  const user = db
    .prepare("SELECT id, name, email, role, created_at FROM users WHERE id = ?")
    .get(userId) as unknown as User;
  res.status(201).json({ user });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Dados inválidos" });
    return;
  }
  const row = db
    .prepare("SELECT id, name, email, role, created_at, password_hash FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as unknown as (User & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: "E-mail ou senha incorretos" });
    return;
  }
  createSession(res, row.id);
  const { password_hash: _ignored, ...user } = row;
  res.json({ user });
});

app.post("/api/auth/logout", (req, res) => {
  destroySession(req, res);
  res.status(204).end();
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.user ?? null });
});

app.get("/api/users", requireAuth, requireRole("admin"), (_req, res) => {
  const users = db
    .prepare("SELECT id, name, email, role, created_at FROM users ORDER BY id")
    .all();
  res.json({ users });
});

// Em produção serve o front-end compilado (client/dist).
const clientDist = path.join(process.cwd(), "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Ethos rodando em http://localhost:${port}`);
});
