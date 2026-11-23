import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db, type User } from "./db.js";

const SESSION_COOKIE = "ethos_sid";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function createSession(res: Response, userId: number): void {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = Date.now() + SESSION_TTL_MS;
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, expires);
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
  });
}

export function destroySession(req: Request, res: Response): void {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  res.clearCookie(SESSION_COOKIE);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) {
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`,
      )
      .get(id, Date.now()) as unknown as User | undefined;
    if (row) req.user = row;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  next();
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.role !== role) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    next();
  };
}
