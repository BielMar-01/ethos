import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db, type AuthContext, type Role } from "./db.js";
import { RateLimiter } from "./ratelimit.js";

export const SESSION_COOKIE = "ethos_sid";
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

/** Abre a sessão e guarda de onde ela veio (aparelho e IP), para a lista "Seus aparelhos" do perfil. */
export async function createSession(res: Response, userId: number, organizationId: number, req?: Request): Promise<void> {
  const id = crypto.randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions (id, user_id, organization_id, expires_at, user_agent, ip) VALUES ($1, $2, $3, $4, $5, $6)", [
    id,
    userId,
    organizationId,
    new Date(Date.now() + SESSION_TTL_MS),
    req?.get("user-agent")?.slice(0, 300) ?? null,
    req?.ip?.slice(0, 64) ?? null,
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

export function currentSessionId(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
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
  tenant_id: number | null;
  owner_id: number | null;
}

export const hashApiKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const API_KEY_RE = /^Bearer (ethos_[A-Za-z0-9_-]{20,})$/;
const apiKeyLimiter = new RateLimiter(600, 60 * 1000); // 600 req/min por chave

/**
 * Identifica o chamador. `Authorization: Bearer ethos_...` (chave de API) tem precedência sobre o
 * cookie. Chaves são SOMENTE LEITURA e agem como colaborador da organização que as criou.
 */
export async function loadAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ethos_")) {
    const token = API_KEY_RE.exec(header)?.[1];
    const [key] = token
      ? await db.query<{ id: number; name: string; organization_id: number; organization_name: string }>(
          `SELECT k.id, k.name, k.organization_id, o.name AS organization_name
           FROM api_keys k JOIN organizations o ON o.id = k.organization_id
           WHERE k.token_hash = $1 AND k.revoked_at IS NULL`,
          [hashApiKey(token)],
        )
      : [];
    if (!key) {
      res.status(401).json({ error: "Chave de API inválida ou revogada" });
      return;
    }
    if (!apiKeyLimiter.allow(`key:${key.id}`)) {
      res.status(429).json({ error: "Limite de requisições da chave excedido (600/min)" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      res.status(403).json({ error: "Chaves de API são somente leitura" });
      return;
    }
    await db.query(
      "UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
      [key.id],
    );
    req.auth = {
      user: { id: 0, name: `API: ${key.name}`, email: "" },
      organization: { id: key.organization_id, name: key.organization_name },
      role: "colaborador",
      tenantId: null,
      ownerId: null,
      viaApiKey: true,
    };
    next();
    return;
  }

  const id = readCookie(req, SESSION_COOKIE);
  if (id) {
    const [row] = await db.query<SessionRow>(
      `SELECT u.id AS user_id, u.name AS user_name, u.email,
              o.id AS organization_id, o.name AS organization_name, m.role, m.tenant_id, m.owner_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN organizations o ON o.id = s.organization_id
       JOIN organization_members m ON m.user_id = u.id AND m.organization_id = o.id
       WHERE s.id = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`,
      [id],
    );
    if (row) {
      // "Visto por último" sem escrever a cada requisição (no máximo a cada 5 minutos).
      void db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'", [id]).catch(() => {});
      req.auth = {
        user: { id: row.user_id, name: row.user_name, email: row.email },
        organization: { id: row.organization_id, name: row.organization_name },
        role: row.role,
        tenantId: row.tenant_id,
        ownerId: row.owner_id,
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
