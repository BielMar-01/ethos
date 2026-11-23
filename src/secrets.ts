import crypto from "node:crypto";

/**
 * Cifra segredos de integrações no banco (AES-256-GCM). A chave vem de INTEGRATIONS_SECRET (≥ 32 caracteres, só no servidor).
 * Formato guardado: "v1.<iv>.<tag>.<texto cifrado>" em base64url. Sem a variável, NÃO se guarda segredo nenhum (falha clara).
 */

export class SecretsNotConfigured extends Error {
  constructor() {
    super("Defina INTEGRATIONS_SECRET (32+ caracteres) no servidor para guardar chaves com segurança.");
  }
}

const key = (): Buffer => {
  const secret = process.env.INTEGRATIONS_SECRET;
  if (!secret || secret.length < 32) throw new SecretsNotConfigured();
  return crypto.createHash("sha256").update(secret).digest();
};

export const secretsReady = () => (process.env.INTEGRATIONS_SECRET ?? "").length >= 32;

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Segredo em formato desconhecido");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Últimos 4 caracteres, só para o usuário reconhecer a chave na tela. */
export const hintOf = (plain: string) => plain.slice(-4);
