/**
 * Uso:
 *   npm run user:reset-password            → lista os administradores
 *   npm run user:reset-password -- e@x.com → gera senha temporária, aplica e imprime
 */
import crypto from "node:crypto";
import { closeDb, db } from "../db.js";
import { getAuthProvider } from "../authProvider.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generatePassword(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    const admins = await db.query<{ name: string; email: string; organization: string }>(
      `SELECT u.name, u.email, o.name AS organization
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.role = 'admin' ORDER BY u.id`,
    );
    if (admins.length === 0) console.log("Nenhum administrador cadastrado.");
    for (const a of admins) console.log(`${a.email}  (${a.name} — ${a.organization})`);
    return;
  }

  const [user] = await db.query<{ id: number; auth_id: string | null }>(
    "SELECT id, auth_id FROM users WHERE email = $1",
    [email],
  );
  if (!user) {
    console.error("Usuário não encontrado.");
    process.exitCode = 1;
    return;
  }
  const password = generatePassword();
  const provider = getAuthProvider();
  if (user.auth_id) {
    await provider.setPassword(user.auth_id, password);
  } else {
    // Conta antiga (senha em hash local): cria a credencial no Supabase Auth e vincula.
    const created = await provider.createUser(email, password);
    await db.query("UPDATE users SET auth_id = $1 WHERE id = $2", [created.id, user.id]);
    console.log("Conta criada no Supabase Auth e vinculada ao usuário.");
  }
  await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
  console.log(`Senha temporária de ${email}: ${password}`);
  console.log("Todas as sessões deste usuário foram encerradas. Troque a senha após entrar.");
}

main()
  .catch((err) => {
    console.error("Falha:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);
