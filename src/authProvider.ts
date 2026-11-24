import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./auth.js";

/** Falhas do provedor de identidade que a API sabe traduzir em resposta HTTP. */
export class AuthProviderError extends Error {
  constructor(
    public code: "exists" | "weak_password" | "rate_limited" | "unavailable" | "unconfirmed",
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
  /** `confirmed: false` deixa o e-mail pendente até o usuário clicar no link (ver sendVerification). */
  createUser(email: string, password: string, opts?: { confirmed?: boolean }): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
  /** Devolve o id do usuário se as credenciais forem válidas; senão null. Lança "unconfirmed" se a senha confere mas o e-mail não foi verificado. */
  verifyCredentials(email: string, password: string): Promise<{ id: string } | null>;
  /** Envia o e-mail de recuperação (não revela se o e-mail existe). */
  sendRecovery(email: string, redirectTo: string): Promise<void>;
  /** Gera o link de recuperação sem enviar e-mail (uso do administrador). */
  generateRecoveryLink(email: string, redirectTo: string): Promise<string>;
  /** Valida o access_token de um link de recuperação e devolve o usuário dono. */
  userFromRecoveryToken(token: string): Promise<{ id: string; email: string } | null>;
  setPassword(id: string, password: string): Promise<void>;
  /** Envia o link de verificação do cadastro (só vale para e-mail ainda não confirmado). */
  sendVerification(email: string, redirectTo: string): Promise<void>;
  /**
   * Pede a troca de e-mail: o provedor envia o link de confirmação ao endereço NOVO e só troca o login depois do
   * clique. Exige a senha (o provedor abre uma sessão própria com ela). Lança "exists" se o e-mail já é de outra conta.
   */
  requestEmailChange(email: string, password: string, newEmail: string, redirectTo: string): Promise<void>;
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

  async createUser(email: string, password: string, opts: { confirmed?: boolean } = {}) {
    const { status, json } = await this.call("/auth/v1/admin/users", {
      key: this.secretKey,
      // Por padrão o e-mail já nasce confirmado (convite/cadastro controlado pelo app); `confirmed:false` exige o link.
      body: { email, password, email_confirm: opts.confirmed !== false },
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
    if (json.error_code === "email_not_confirmed") throw new AuthProviderError("unconfirmed");
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
    return { id: String(json.id), email: String(json.email ?? "") };
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

  async sendVerification(email: string, redirectTo: string) {
    const { status } = await this.call(`/auth/v1/resend?redirect_to=${encodeURIComponent(redirectTo)}`, {
      key: this.publishableKey,
      body: { type: "signup", email },
    });
    if (status >= 400) throw new AuthProviderError("unavailable", `resend falhou (HTTP ${status})`);
  }

  async requestEmailChange(email: string, password: string, newEmail: string, redirectTo: string) {
    // O pedido de troca de e-mail é do PRÓPRIO usuário (token dele): o provedor manda o link ao endereço novo.
    const login = await this.call("/auth/v1/token?grant_type=password", { key: this.publishableKey, body: { email, password } });
    const token = login.json.access_token;
    if (login.status >= 400 || typeof token !== "string") throw new AuthProviderError("unavailable", `login falhou (HTTP ${login.status})`);
    const { status, json } = await this.call(`/auth/v1/user?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: "PUT",
      key: this.publishableKey,
      bearer: token,
      body: { email: newEmail },
    });
    if (status === 422 || json.error_code === "email_exists") throw new AuthProviderError("exists");
    if (status >= 400) throw new AuthProviderError("unavailable", `updateUser falhou (HTTP ${status})`);
  }
}

// ----------------------------------------------------------------- Memória

/** Implementação em memória para testes. Expõe o que seria enviado por e-mail. */
export class MemoryAuthProvider implements AuthProvider {
  private users = new Map<string, { id: string; email: string; hash: string; confirmed: boolean; pending?: string }>();
  private tokens = new Map<string, string>();
  /** Links de recuperação "enviados" por e-mail (para os testes lerem). */
  sentRecoveries: { email: string; link: string }[] = [];
  /** Links de verificação de cadastro e de troca de e-mail "enviados" (o de troca vai ao endereço NOVO). */
  sentVerifications: { email: string; link: string }[] = [];
  sentEmailChanges: { email: string; link: string }[] = [];

  async createUser(email: string, password: string, opts: { confirmed?: boolean } = {}) {
    if ([...this.users.values()].some((u) => u.email === email)) throw new AuthProviderError("exists");
    const id = crypto.randomUUID();
    this.users.set(id, { id, email, hash: hashPassword(password), confirmed: opts.confirmed !== false });
    return { id };
  }

  /** Simula o clique no link recebido por e-mail: confirma o cadastro / efetiva a troca e devolve o access_token do redirecionamento. */
  clickLink(link: string): string {
    const params = new URLSearchParams(link.split("#")[1] ?? "");
    const [kind, uid] = (params.get("access_token") ?? "").split(":");
    const u = this.users.get(uid ?? "");
    if (!u) throw new Error("link inválido");
    if (kind === "memsignup") u.confirmed = true;
    else if (kind === "memec" && u.pending) {
      u.email = u.pending;
      u.pending = undefined;
    }
    const token = "mem-" + crypto.randomBytes(16).toString("hex");
    this.tokens.set(token, u.id);
    return token;
  }

  async deleteUser(id: string) {
    this.users.delete(id);
  }

  async verifyCredentials(email: string, password: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    if (!u || !verifyPassword(password, u.hash)) return null;
    if (!u.confirmed) throw new AuthProviderError("unconfirmed");
    return { id: u.id };
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
    const u = id ? this.users.get(id) : undefined;
    return u ? { id: u.id, email: u.email } : null;
  }

  async setPassword(id: string, password: string) {
    const u = this.users.get(id);
    if (!u) throw new AuthProviderError("unavailable", "usuário inexistente");
    u.hash = hashPassword(password);
    for (const [t, uid] of this.tokens) if (uid === id) this.tokens.delete(t);
  }

  async sendVerification(email: string, redirectTo: string) {
    const u = [...this.users.values()].find((x) => x.email === email && !x.confirmed);
    if (u) this.sentVerifications.push({ email, link: `${redirectTo}#access_token=memsignup:${u.id}&type=signup` });
  }

  async requestEmailChange(email: string, password: string, newEmail: string, redirectTo: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    if (!u || !verifyPassword(password, u.hash)) throw new AuthProviderError("unavailable", "credenciais inválidas");
    if ([...this.users.values()].some((x) => x.email === newEmail && x.id !== u.id)) throw new AuthProviderError("exists");
    u.pending = newEmail;
    this.sentEmailChanges.push({ email: newEmail, link: `${redirectTo}#access_token=memec:${u.id}&type=email_change` });
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
