import type { Request, Response } from "express";
import { db } from "./db.js";
import { getAuthProvider } from "./authProvider.js";
import { SharedRateLimiter } from "./ratelimit.js";

const limiter = new SharedRateLimiter("reauth", 5, 15 * 60 * 1000); // tentativas de senha atual por usuário

/**
 * Reautenticação para ações sensíveis (trocar e-mail/senha, 2FA, apagar a conta): confere a senha atual
 * com limite de tentativas. Devolve o id no provedor de identidade ou já responde o erro (e devolve undefined).
 */
export async function confirmPassword(req: Request, res: Response, password: unknown): Promise<string | undefined> {
  if (typeof password !== "string" || !password) {
    res.status(400).json({ error: "Informe a sua senha atual." });
    return undefined;
  }
  const key = `user:${req.auth!.user.id}`;
  if (!(await limiter.allow(key))) {
    res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
    return undefined;
  }
  const [u] = await db.query<{ email: string; auth_id: string; pending_email: string | null }>("SELECT email, auth_id, pending_email FROM users WHERE id = $1", [req.auth!.user.id]);
  let ok = u ? await getAuthProvider().verifyCredentials(u.email, password) : null;
  if (u && !ok && u.pending_email) {
    // O link de troca já foi confirmado no provedor, mas o app ainda não espelhou: a senha vale no e-mail novo.
    ok = await getAuthProvider().verifyCredentials(u.pending_email, password);
    if (ok && ok.id === u.auth_id) await db.query("UPDATE users SET email = pending_email, pending_email = NULL, pending_email_at = NULL WHERE id = $1", [req.auth!.user.id]);
  }
  if (!u || !ok || ok.id !== u.auth_id) {
    res.status(403).json({ error: "Senha atual incorreta." });
    return undefined;
  }
  await limiter.reset(key);
  return u.auth_id;
}
