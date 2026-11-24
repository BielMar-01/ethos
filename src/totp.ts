import crypto from "node:crypto";

/** TOTP (RFC 6238) com HMAC-SHA1, 6 dígitos, passo de 30 s: compatível com Google Authenticator, Authy, 1Password etc. */

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Base32 inválido");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo: 20 bytes aleatórios (160 bits), em base32. */
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

const stepOf = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_S);

export function hotp(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export const totpAt = (secretB32: string, ms = Date.now()) => hotp(secretB32, stepOf(ms));

/**
 * Confere o código aceitando 1 passo de folga para cada lado (relógio do celular). Devolve o passo que bateu,
 * ou null. `afterStep` rejeita passos já usados (o mesmo código não vale duas vezes).
 */
export function verifyTotp(secretB32: string, code: string, opts: { afterStep?: number | null; now?: number } = {}): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = stepOf(opts.now ?? Date.now());
  let matched: number | null = null;
  for (const delta of [-1, 0, 1]) {
    const step = current + delta;
    const expected = Buffer.from(hotp(secretB32, step));
    // Sem curto-circuito: o tempo de resposta não revela em qual passo bateu.
    if (crypto.timingSafeEqual(expected, Buffer.from(clean)) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.afterStep != null && matched <= opts.afterStep) return null;
  return matched;
}

export const otpauthUri = (secretB32: string, account: string, issuer = "Ethos") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;

// Códigos de recuperação: 10 códigos de uso único, sem caracteres ambíguos.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const piece = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]).join("");
export const generateRecoveryCodes = (n = 10) => Array.from({ length: n }, () => `${piece()}-${piece()}`);
/** Aceita com ou sem hífen, maiúsculas ou minúsculas. */
export const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecovery = (code: string) => crypto.createHash("sha256").update(normalizeRecovery(code)).digest("hex");
