import crypto from "node:crypto";
import { db } from "./db.js";

/** Limitador simples em memória (por processo). Suficiente para uma instância única. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** Registra uma tentativa; devolve false quando o limite foi excedido. */
  allow(key: string): boolean {
    const now = Date.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/**
 * Limitador compartilhado entre instâncias (guardado no banco). Use nas rotas de segurança (login, senha, 2FA…),
 * onde o limite por processo não vale em hospedagem sem servidor. Uma única instrução atômica por tentativa.
 * A chave é gravada como SHA-256 (nada de e-mail ou IP legível na tabela).
 */
export class SharedRateLimiter {
  constructor(
    private scope: string,
    private max: number,
    private windowMs: number,
  ) {}

  private hash(key: string) {
    return crypto.createHash("sha256").update(`${this.scope}\u0000${key}`).digest("hex");
  }

  /** Registra uma tentativa; devolve false quando o limite foi excedido. */
  async allow(key: string): Promise<boolean> {
    const rows = await db.query<{ count: number }>(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2::double precision))
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING count`,
      [this.hash(key), this.windowMs / 1000],
    );
    // Limpeza oportunista das janelas vencidas (sem agendador).
    if (Math.random() < 0.02) void db.query("DELETE FROM rate_limits WHERE reset_at < now()").catch(() => {});
    return rows[0]!.count <= this.max;
  }

  async reset(key: string): Promise<void> {
    await db.query("DELETE FROM rate_limits WHERE key = $1", [this.hash(key)]);
  }
}
