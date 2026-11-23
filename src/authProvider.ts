import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./auth.js";

/** Falhas do provedor de identidade que a API sabe traduzir em resposta HTTP. */
export class AuthProviderError extends Error {
  constructor(
    public code: "exists" | "weak_password" | "rate_limited" | "unavailable",
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * Provedor de identidade (credenciais e e-mails de recuperação).
 * Produção: Supabase Auth. Testes: implementação em memória.
 */
export interface AuthProvider {
  createUser(email: string, password: string): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
  /** Devolve o id do usuário se as credenciais forem válidas; senão null. */
  verifyCredentials(email: string, password: string): Promise<{ id: string } | null>;
  /** Envia o e-mail de recuperação (não revela se o e-mail existe). */
  sendRecovery(email: string, redirectTo: string): Promise<void>;
  /** Gera o link de recuperação sem enviar e-mail (uso do administrador). */
  generateRecoveryLink(email: string, redirectTo: string): Promise<string>;
  /** Valida o access_token de um link de recuperação e devolve o usuário dono. */
  userFromRecoveryToken(token: string): Promise<{ id: string } | null>;
  setPassword(id: string, password: string): Promise<void>;
}

// ---------------------------------------------------------------- Supabase

class SupabaseAuthProvider implements AuthProvider {
  constructor(
    private url: string,
    private publishableKey: string,
    private secretKey: string,
  ) {}

  private async call(
    path: string,
    opts: { method?: string; key: string; body?: unknown; bearer?: string },
  ): Promise<{ status: number; json: Record<string, any> }> {
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method: opts.method ?? "POST",
        headers: {
          apikey: opts.key,
          "Content-Type": "application/json",
          ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AuthProviderError("unavailable", "Supabase Auth indisponível");
    }
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* corpo não-JSON */
    }
    if (res.status === 429) throw new AuthProviderError("rate_limited");
    if (res.status >= 500) throw new AuthProviderError("unavailable", `Supabase Auth: HTTP ${res.status}`);
    return { status: res.status, json };
  }

  async createUser(email: string, password: string) {
    const { status, json } = await this.call("/auth/v1/admin/users", {
      key: this.secretKey,
      // E-mail marcado como confirmado: o convite/cadastro já foi controlado pelo app.
      body: { email, password, email_confirm: true },
    });
    if (status === 422 && json.error_code === "weak_password") throw new AuthProviderError("weak_password", json.msg);
    if (status === 422 || json.error_code === "email_exists") throw new AuthProviderError("exists");
    if (status >= 400 || !json.id) throw new AuthProviderError("unavailable", `createUser falhou (HTTP ${status})`);
    return { id: String(json.id) };
  }

  async deleteUser(id: string) {
    await this.call(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", key: this.secretKey });
  }

  async verifyCredentials(email: string, password: string) {
    const { status, json } = await this.call("/auth/v1/token?grant_type=password", {
      key: this.publishableKey,
      body: { email, password },
    });
    if (status === 400 || status === 401 || status === 422) return null;
    if (status >= 400 || !json.user?.id) throw new AuthProviderError("unavailable", `login falhou (HTTP ${status})`);
    return { id: String(json.user.id) };
  }

  async sendRecovery(email: string, redirectTo: string) {
    const { status } = await this.call(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
      key: this.publishableKey,
      body: { email },
    });
    if (status >= 400) throw new AuthProviderError("unavailable", `recover falhou (HTTP ${status})`);
  }

  async generateRecoveryLink(email: string, redirectTo: string) {
    const { status, json } = await this.call("/auth/v1/admin/generate_link", {
      key: this.secretKey,
      body: { type: "recovery", email, redirect_to: redirectTo },
    });
    const link = json.action_link ?? json.properties?.action_link;
    if (status >= 400 || typeof link !== "string") {
      throw new AuthProviderError("unavailable", `generate_link falhou (HTTP ${status})`);
    }
    return link;
  }

  async userFromRecoveryToken(token: string) {
    const { status, json } = await this.call("/auth/v1/user", {
      method: "GET",
      key: this.publishableKey,
      bearer: token,
    });
    if (status >= 400 || !json.id) return null;
    return { id: String(json.id) };
  }

  async setPassword(id: string, password: string) {
    const { status, json } = await this.call(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
      method: "PUT",
      key: this.secretKey,
      body: { password },
    });
    if (status === 422 && json.error_code === "weak_password") throw new AuthProviderError("weak_password", json.msg);
    if (status >= 400) throw new AuthProviderError("unavailable", `setPassword falhou (HTTP ${status})`);
  }
}

// ----------------------------------------------------------------- Memória

/** Implementação em memória para testes. Expõe o que seria enviado por e-mail. */
export class MemoryAuthProvider implements AuthProvider {
  private users = new Map<string, { id: string; email: string; hash: string }>();
  private tokens = new Map<string, string>();
  /** Links de recuperação "enviados" por e-mail (para os testes lerem). */
  sentRecoveries: { email: string; link: string }[] = [];

  async createUser(email: string, password: string) {
    if ([...this.users.values()].some((u) => u.email === email)) throw new AuthProviderError("exists");
    const id = crypto.randomUUID();
    this.users.set(id, { id, email, hash: hashPassword(password) });
    return { id };
  }

  async deleteUser(id: string) {
    this.users.delete(id);
  }

  async verifyCredentials(email: string, password: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    return u && verifyPassword(password, u.hash) ? { id: u.id } : null;
  }

  private makeLink(email: string, redirectTo: string): string | undefined {
    const u = [...this.users.values()].find((x) => x.email === email);
    if (!u) return undefined;
    const token = "mem-" + crypto.randomBytes(16).toString("hex");
    this.tokens.set(token, u.id);
    return `${redirectTo}#access_token=${token}&type=recovery`;
  }

  async sendRecovery(email: string, redirectTo: string) {
    const link = this.makeLink(email, redirectTo);
    if (link) this.sentRecoveries.push({ email, link });
  }

  async generateRecoveryLink(email: string, redirectTo: string) {
    const link = this.makeLink(email, redirectTo);
    if (!link) throw new AuthProviderError("unavailable", "usuário inexistente");
    return link;
  }

  async userFromRecoveryToken(token: string) {
    const id = this.tokens.get(token);
    return id ? { id } : null;
  }

  async setPassword(id: string, password: string) {
    const u = this.users.get(id);
    if (!u) throw new AuthProviderError("unavailable", "usuário inexistente");
    u.hash = hashPassword(password);
    for (const [t, uid] of this.tokens) if (uid === id) this.tokens.delete(t);
  }
}

// ------------------------------------------------------------------ Seleção

let provider: AuthProvider | undefined;

export function getAuthProvider(): AuthProvider {
  if (provider) return provider;
  if (process.env.ETHOS_DB === "memory") {
    provider = new MemoryAuthProvider();
  } else {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
      throw new Error("SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY e SUPABASE_SECRET_KEY são obrigatórias (veja .env.example).");
    }
    provider = new SupabaseAuthProvider(SUPABASE_URL.replace(/\/$/, ""), SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY);
  }
  return provider;
}

export const appUrl = (): string => (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
