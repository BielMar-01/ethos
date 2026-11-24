import { Router } from "express";
import { db, isUniqueViolation } from "./db.js";
import { currentSessionId, requireAuth } from "./auth.js";
import { AuthProviderError, getAuthProvider } from "./authProvider.js";
import { isRealDate } from "./crud.js";
import { formatDocument, formatPhone } from "./brFormat.js";
import { RateLimiter } from "./ratelimit.js";

/**
 * "Meu perfil": cada pessoa edita os próprios dados (nome, telefone, CPF, nascimento), troca o e-mail e a senha
 * e encerra as outras sessões. Vale para todos os papéis, sempre sobre o usuário da sessão (nunca um id do cliente).
 * Trocar e-mail e senha exige a senha atual. A senha nunca é gravada na auditoria (a auditoria não guarda o corpo).
 */
export const profileRouter = Router();
profileRouter.use("/profile", requireAuth, (req, res, next) => {
  if (req.auth!.viaApiKey) return void res.status(403).json({ error: "Chaves de API não têm perfil." });
  next();
});

const sensitiveLimiter = new RateLimiter(5, 15 * 60 * 1000); // tentativas de senha atual por usuário
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

interface ProfileRow {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  document: string | null;
  birth_date: string | null;
  created_at: string;
}

const load = async (userId: number) => (await db.query<ProfileRow>("SELECT id, name, email, phone, document, birth_date, created_at FROM users WHERE id = $1", [userId]))[0]!;

profileRouter.get("/profile", async (req, res) => {
  const a = req.auth!;
  const organizations = await db.query("SELECT o.id, o.name, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1 ORDER BY o.name", [a.user.id]);
  res.json({ user: await load(a.user.id), role: a.role, organization: a.organization, organizations });
});

profileRouter.put("/profile", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const cur = await load(req.auth!.user.id);

  const name = b.name === undefined ? cur.name : typeof b.name === "string" ? b.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 100) return void res.status(400).json({ error: "Informe seu nome (de 2 a 100 caracteres)." });

  let phone = cur.phone;
  if (b.phone !== undefined) {
    const raw = typeof b.phone === "string" ? b.phone.trim() : "";
    if (!raw) phone = null;
    else {
      let d = raw.replace(/\D/g, "");
      if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
      if (d.length !== 10 && d.length !== 11) return void res.status(400).json({ error: "Telefone inválido. Use DDD + número, por exemplo (11) 91234-5678." });
      phone = formatPhone(d);
    }
  }

  let document = cur.document;
  if (b.document !== undefined) {
    const raw = typeof b.document === "string" ? b.document.trim() : "";
    if (!raw) document = null;
    else {
      const d = raw.replace(/\D/g, "");
      if (d.length !== 11 && d.length !== 14) return void res.status(400).json({ error: "CPF ou CNPJ inválido: informe 11 ou 14 números." });
      document = formatDocument(d);
    }
  }

  let birth = cur.birth_date;
  if (b.birth_date !== undefined) {
    const raw = typeof b.birth_date === "string" ? b.birth_date.trim() : "";
    if (!raw) birth = null;
    else {
      if (!isRealDate(raw) || raw < "1900-01-01" || raw > new Date().toISOString().slice(0, 10)) return void res.status(400).json({ error: "Data de nascimento inválida." });
      birth = raw;
    }
  }

  await db.query("UPDATE users SET name = $1, phone = $2, document = $3, birth_date = $4 WHERE id = $5", [name, phone, document, birth, req.auth!.user.id]);
  res.json({ user: await load(req.auth!.user.id) });
});

/** Confere a senha atual (com limite de tentativas). Devolve o id no provedor de identidade ou responde o erro. */
async function confirmPassword(req: import("express").Request, res: import("express").Response, password: unknown): Promise<string | undefined> {
  if (typeof password !== "string" || !password) {
    res.status(400).json({ error: "Informe a sua senha atual." });
    return undefined;
  }
  if (!sensitiveLimiter.allow(`profile:${req.auth!.user.id}`)) {
    res.status(429).json({ error: "Muitas tentativas. Tente novamente em alguns minutos." });
    return undefined;
  }
  const [u] = await db.query<{ email: string; auth_id: string }>("SELECT email, auth_id FROM users WHERE id = $1", [req.auth!.user.id]);
  const ok = u ? await getAuthProvider().verifyCredentials(u.email, password) : null;
  if (!u || !ok || ok.id !== u.auth_id) {
    res.status(403).json({ error: "Senha atual incorreta." });
    return undefined;
  }
  sensitiveLimiter.reset(`profile:${req.auth!.user.id}`);
  return u.auth_id;
}

profileRouter.post("/profile/email", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) return void res.status(400).json({ error: "Informe um e-mail válido." });
  if (email === req.auth!.user.email) return void res.status(400).json({ error: "Este já é o seu e-mail." });
  const authId = await confirmPassword(req, res, req.body?.password);
  if (!authId) return;
  const taken = await db.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (taken.length > 0) return void res.status(409).json({ error: "Já existe uma conta com este e-mail." });
  try {
    await getAuthProvider().updateEmail(authId, email);
    await db.query("UPDATE users SET email = $1 WHERE id = $2", [email, req.auth!.user.id]);
  } catch (err) {
    if (err instanceof AuthProviderError && err.code === "exists") return void res.status(409).json({ error: "Já existe uma conta com este e-mail." });
    if (isUniqueViolation(err)) return void res.status(409).json({ error: "Já existe uma conta com este e-mail." });
    throw err;
  }
  res.json({ user: await load(req.auth!.user.id) });
});

profileRouter.post("/profile/password", async (req, res) => {
  const next = req.body?.new_password;
  if (typeof next !== "string" || next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
    return void res.status(400).json({ error: `A nova senha deve ter de ${MIN_PASSWORD} a ${MAX_PASSWORD} caracteres.` });
  }
  if (next === req.body?.current_password) return void res.status(400).json({ error: "A nova senha deve ser diferente da atual." });
  const authId = await confirmPassword(req, res, req.body?.current_password);
  if (!authId) return;
  try {
    await getAuthProvider().setPassword(authId, next);
  } catch (err) {
    if (err instanceof AuthProviderError && err.code === "weak_password") return void res.status(400).json({ error: "Senha fraca demais. Escolha outra." });
    throw err;
  }
  // Troca de senha derruba as outras sessões (a atual continua).
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [req.auth!.user.id, currentSessionId(req) ?? ""]);
  res.status(204).end();
});

profileRouter.post("/profile/sessions/logout-others", async (req, res) => {
  const rows = await db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2 RETURNING id", [req.auth!.user.id, currentSessionId(req) ?? ""]);
  res.json({ ended: rows.length });
});
