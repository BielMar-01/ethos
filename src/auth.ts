import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db, type AuthContext, type Role } from "./db.js";
// loadAuth é async: o Express 5 encaminha rejeições ao tratador de erros.

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

export async function createSession(res: Response, userId: number, organizationId: number): Promise<void> {
  const id = crypto.randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions (id, user_id, organization_id, expires_at) VALUES ($1, $2, $3, $4)", [
    id,
    userId,
    organizationId,
    new Date(Date.now() + SESSION_TTL_MS),
  ]);
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS,
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) await db.query("DELETE FROM sessions WHERE id = $1", [id]);
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
    /** Contexto autenticado. A organização vem SEMPRE da sessão, nunca do cliente. */
    auth?: AuthContext;
  }
}

interface SessionRow {
  user_id: number;
  user_name: string;
  email: string;
  organization_id: number;
  organization_name: string;
  role: Role;
}

export async function loadAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) {
    const [row] = await db.query<SessionRow>(
      `SELECT u.id AS user_id, u.name AS user_name, u.email,
              o.id AS organization_id, o.name AS organization_name, m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = s.organization_id
       JOIN organization_members m ON m.user_id = u.id AND m.organization_id = o.id
       WHERE s.id = $1 AND s.expires_at > now()`,
      [id],
    );
    if (row) {
      req.auth = {
        user: { id: row.user_id, name: row.user_name, email: row.email },
        organization: { id: row.organization_id, name: row.organization_name },
        role: row.role,
      };
    }
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: "Não autenticado" });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: "Sem permissão" });
      return;
    }
    next();
  };
}
