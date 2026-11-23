import Anthropic from "@anthropic-ai/sdk";
import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { RateLimiter } from "./ratelimit.js";
import { SecretsNotConfigured, decryptSecret, encryptSecret, hintOf } from "./secrets.js";
import { secretsReady } from "./secrets.js";
import { AI_IDS, AI_PROVIDERS, MODEL_ID_RE, aiProvider, isAiProvider, type AiProviderDef } from "./aiProviders.js";
import { assertPublicUrl } from "./webhooks.js";

/**
 * Integrações com serviços externos, configuradas por organização e só pelo administrador:
 *  - Asaas (pagamentos): guarda a chave e o ambiente e testa a conexão. Emitir boleto/Pix/cartão ainda NÃO existe.
 *  - IA (leitura de documentos): Anthropic, OpenAI, Gemini, Grok, DeepSeek, Mistral, Groq, Together, OpenRouter ou qualquer
 *    endpoint compatível com a API da OpenAI. Pode haver vários configurados; UM é o "principal" e é o que a leitura usa.
 * As chaves ficam cifradas (ver secrets.ts) e NUNCA voltam para o navegador: só os 4 últimos caracteres.
 */

export const PROVIDERS = ["asaas", ...AI_IDS] as const;
export const ASAAS_URLS = { sandbox: "https://api-sandbox.asaas.com/v3", production: "https://api.asaas.com/v3" } as const;

interface Row {
  provider: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secret_enc: string | null;
  secret_hint: string | null;
  last_tested_at: Date | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  updated_at: Date;
}
const COLUMNS = "provider, enabled, config, secret_enc, secret_hint, last_tested_at, last_status, last_error, updated_at";

const publicView = (r: Row | undefined) =>
  r
    ? { configured: Boolean(r.secret_enc), enabled: r.enabled, config: r.config, hint: r.secret_hint, last_tested_at: r.last_tested_at, last_status: r.last_status, last_error: r.last_error, updated_at: r.updated_at }
    : { configured: false, enabled: false, config: {}, hint: null, last_tested_at: null, last_status: null, last_error: null, updated_at: null };

async function load(orgId: number, provider: string): Promise<Row | undefined> {
  const [row] = await db.query<Row>(`SELECT ${COLUMNS} FROM integrations WHERE organization_id = $1 AND provider = $2`, [orgId, provider]);
  return row;
}

/** O provedor de IA que a leitura de documentos deve usar nesta organização (ativo, com chave e marcado como principal). */
export async function orgAi(orgId: number): Promise<{ provider: AiProviderDef; apiKey: string; model: string | null; baseUrl: string | null } | null> {
  const rows = await db.query<Row>(`SELECT ${COLUMNS} FROM integrations WHERE organization_id = $1 AND provider = ANY($2::text[]) AND enabled AND secret_enc IS NOT NULL`, [orgId, AI_IDS]);
  const row = rows.find((r) => r.config.primary === true) ?? (rows.length === 1 ? rows[0] : undefined);
  const def = row && aiProvider(row.provider);
  if (!row || !def) return null;
  try {
    return {
      provider: def,
      apiKey: decryptSecret(row.secret_enc!),
      model: typeof row.config.model === "string" && row.config.model ? row.config.model : null,
      baseUrl: typeof row.config.base_url === "string" ? row.config.base_url : null,
    };
  } catch {
    return null; // segredo ilegível (INTEGRATIONS_SECRET mudou): cai na chave do servidor
  }
}

/** Para testes: troca a criação do cliente Anthropic usado no teste de conexão. */
let anthropicTestClient: (apiKey: string) => Pick<Anthropic, "models"> = (apiKey) => new Anthropic({ apiKey });
export function setAnthropicTestClient(f: ((apiKey: string) => Pick<Anthropic, "models">) | null) {
  anthropicTestClient = f ?? ((apiKey) => new Anthropic({ apiKey }));
}

export const integrationsRouter = Router();
integrationsRouter.use("/integrations", requireAuth, requireRole("admin"));
const testLimiter = new RateLimiter(10, 60 * 1000);

integrationsRouter.get("/integrations", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const rows = await db.query<Row>(`SELECT ${COLUMNS} FROM integrations WHERE organization_id = $1`, [orgId]);
  const hooks = await db.query<{ n: string; enabled: string }>("SELECT count(*)::text AS n, count(*) FILTER (WHERE enabled)::text AS enabled FROM webhook_endpoints WHERE organization_id = $1", [orgId]);
  const keys = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM api_keys WHERE organization_id = $1 AND revoked_at IS NULL", [orgId]);

  const providers: Record<string, ReturnType<typeof publicView>> = {};
  for (const r of rows) if (isAiProvider(r.provider)) providers[r.provider] = publicView(r);
  const active = await orgAi(orgId);
  res.json({
    secrets_ready: secretsReady(),
    asaas: publicView(rows.find((r) => r.provider === "asaas")),
    ai: {
      catalog: AI_PROVIDERS,
      providers,
      server_key: Boolean(process.env.ANTHROPIC_API_KEY),
      active: active ? { provider: active.provider.id, label: active.provider.label, model: active.model, source: "organization" } : process.env.ANTHROPIC_API_KEY ? { provider: "anthropic", label: "Anthropic (Claude)", model: null, source: "server" } : null,
    },
    webhooks: { total: Number(hooks[0]!.n), enabled: Number(hooks[0]!.enabled) },
    api_keys: { active: Number(keys[0]!.n) },
  });
});

/** Salva (cria ou altera) uma integração. Chave em branco = mantém a atual. */
integrationsRouter.put("/integrations/:provider", async (req, res) => {
  const provider = String(req.params.provider);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    res.status(404).json({ error: "Integração desconhecida" });
    return;
  }
  const orgId = req.auth!.organization.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const current = await load(orgId, provider);
  const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
  const config: Record<string, unknown> = { ...(current?.config ?? {}) };
  const bad = (error: string) => res.status(400).json({ error });

  if (provider === "asaas") {
    const env = b.environment ?? config.environment ?? "sandbox";
    if (env !== "sandbox" && env !== "production") return void bad("Ambiente deve ser sandbox (testes) ou production.");
    config.environment = env;
    if (apiKey && (apiKey.length < 20 || /\s/.test(apiKey))) return void bad("A chave do Asaas parece incompleta. Copie a chave inteira em Integrações › Chaves de API do Asaas.");
  } else {
    const def = aiProvider(provider)!;
    if (def.kind === "anthropic") {
      if (apiKey && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) return void bad("A chave da Anthropic deve começar com sk-ant-. Copie a chave inteira do console.anthropic.com.");
      if (b.model !== undefined) {
        if (b.model !== "" && !def.models.includes(String(b.model))) return void bad("Modelo não permitido para a Anthropic.");
        config.model = b.model || null;
      }
    } else {
      if (apiKey && (apiKey.length < 8 || /\s/.test(apiKey))) return void bad("A chave parece incompleta. Copie a chave inteira, sem espaços.");
      if (b.model !== undefined) {
        const model = String(b.model).trim();
        if (model && !MODEL_ID_RE.test(model)) return void bad("Nome de modelo inválido. Use o ID exato do modelo (ex.: gpt-4o, deepseek-chat, openai/gpt-4o-mini).");
        config.model = model || null;
      }
      if (!config.model) config.model = def.models[0] ?? null;
      if (!config.model) return void bad("Informe o modelo (ID exato) que este serviço deve usar.");
      if (def.id === "custom") {
        const raw = String(b.base_url ?? config.base_url ?? "").trim();
        try {
          await assertPublicUrl(raw);
        } catch (err) {
          return void bad(err instanceof Error ? err.message : "URL base inválida.");
        }
        config.base_url = raw.replace(/\/+$/, "");
      }
    }
  }
  if (!current?.secret_enc && !apiKey) return void bad("Informe a chave de API.");
  const enabled = b.enabled === undefined ? (current?.enabled ?? true) : b.enabled === true;

  // Principal da IA: o primeiro provedor configurado vira principal; marcar outro troca.
  if (provider !== "asaas") {
    const others = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM integrations WHERE organization_id = $1 AND provider = ANY($2::text[]) AND provider <> $3 AND secret_enc IS NOT NULL", [orgId, AI_IDS, provider]);
    const first = Number(others[0]!.n) === 0;
    if (b.primary === true || (first && config.primary === undefined)) config.primary = true;
    else if (b.primary === false) config.primary = false;
  }

  try {
    const secret = apiKey ? { enc: encryptSecret(apiKey), hint: hintOf(apiKey) } : { enc: current!.secret_enc, hint: current!.secret_hint };
    await db.query(
      `INSERT INTO integrations (organization_id, provider, enabled, config, secret_enc, secret_hint)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (organization_id, provider) DO UPDATE
         SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc, secret_hint = EXCLUDED.secret_hint,
             updated_at = now(),
             last_status = CASE WHEN $7 THEN NULL ELSE integrations.last_status END,
             last_error = CASE WHEN $7 THEN NULL ELSE integrations.last_error END,
             last_tested_at = CASE WHEN $7 THEN NULL ELSE integrations.last_tested_at END`,
      [orgId, provider, enabled, JSON.stringify(config), secret.enc, secret.hint, Boolean(apiKey)],
    );
    if (provider !== "asaas" && config.primary === true) {
      await db.query("UPDATE integrations SET config = config - 'primary' WHERE organization_id = $1 AND provider = ANY($2::text[]) AND provider <> $3", [orgId, AI_IDS, provider]);
    }
  } catch (err) {
    if (err instanceof SecretsNotConfigured) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
  res.json({ integration: publicView(await load(orgId, provider)) });
});

integrationsRouter.delete("/integrations/:provider", async (req, res) => {
  const provider = String(req.params.provider);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    res.status(404).json({ error: "Integração desconhecida" });
    return;
  }
  await db.query("DELETE FROM integrations WHERE organization_id = $1 AND provider = $2", [req.auth!.organization.id, provider]);
  res.status(204).end();
});

/** Testa a conexão com a chave guardada. O resultado (ok/erro) fica gravado para aparecer na tela. */
integrationsRouter.post("/integrations/:provider/test", async (req, res) => {
  const provider = String(req.params.provider);
  const orgId = req.auth!.organization.id;
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    res.status(404).json({ error: "Integração desconhecida" });
    return;
  }
  const row = await load(orgId, provider);
  if (!row?.secret_enc) {
    res.status(409).json({ error: "Configure a chave antes de testar." });
    return;
  }
  if (!testLimiter.allow(`int-test:${orgId}`)) {
    res.status(429).json({ error: "Muitos testes seguidos. Aguarde um instante." });
    return;
  }
  let outcome: { ok: boolean; message: string };
  try {
    const key = decryptSecret(row.secret_enc);
    if (provider === "asaas") outcome = await testAsaas(key, String(row.config.environment ?? "sandbox") as keyof typeof ASAAS_URLS);
    else {
      const def = aiProvider(provider)!;
      outcome = def.kind === "anthropic" ? await testAnthropic(key) : await testCompat(def, key, typeof row.config.base_url === "string" ? row.config.base_url : null);
    }
  } catch (err) {
    outcome = { ok: false, message: err instanceof SecretsNotConfigured ? err.message : "Não consegui ler a chave guardada. Salve-a de novo." };
  }
  await db.query("UPDATE integrations SET last_tested_at = now(), last_status = $1, last_error = $2 WHERE organization_id = $3 AND provider = $4", [outcome.ok ? "ok" : "error", outcome.ok ? null : outcome.message, orgId, provider]);
  res.json(outcome);
});

async function testAsaas(key: string, env: keyof typeof ASAAS_URLS): Promise<{ ok: boolean; message: string }> {
  try {
    // "Recuperar saldo" é uma leitura inofensiva que exige chave válida.
    const res = await fetch(`${ASAAS_URLS[env] ?? ASAAS_URLS.sandbox}/finance/balance`, {
      headers: { access_token: key, "User-Agent": "Ethos", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, message: `Conectado ao Asaas (${env === "production" ? "produção" : "sandbox/testes"}).` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `O Asaas recusou a chave. Confira se ela é do ambiente ${env === "production" ? "de produção" : "sandbox"}.` };
    return { ok: false, message: `O Asaas respondeu HTTP ${res.status}. Tente novamente em instantes.` };
  } catch {
    return { ok: false, message: "Não consegui falar com o Asaas agora. Tente novamente." };
  }
}

async function testAnthropic(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    await anthropicTestClient(key).models.list({ limit: 1 }); // listar modelos não consome tokens
    return { ok: true, message: "Conectado à Anthropic." };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return { ok: false, message: "A Anthropic recusou a chave. Confira se ela está ativa em console.anthropic.com." };
    return { ok: false, message: "Não consegui falar com a Anthropic agora. Tente novamente." };
  }
}

/** Provedores compatíveis com a OpenAI: listar modelos exige chave válida e não gasta nada. */
async function testCompat(def: AiProviderDef, key: string, customBase: string | null): Promise<{ ok: boolean; message: string }> {
  const base = (def.baseUrl ?? customBase ?? "").replace(/\/+$/, "");
  try {
    if (!def.baseUrl) await assertPublicUrl(base);
    // O OpenRouter lista modelos sem chave; o endpoint de chave é o que de fato a valida.
    const url = def.id === "openrouter" ? `${base}/auth/key` : `${base}/models`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "Ethos" }, redirect: "manual", signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true, message: `Conectado a ${def.label}.` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `${def.label} recusou a chave. Confira se ela está ativa${def.keyUrl ? ` em ${def.keyUrl}` : ""}.` };
    if (res.status === 404) return { ok: false, message: `Não encontrei ${url.replace(base, "")} em ${base}. Confira a URL base.` };
    return { ok: false, message: `${def.label} respondeu HTTP ${res.status}. Tente novamente em instantes.` };
  } catch (err) {
    if (err instanceof Error && /https|interna|endereço|encontrar/i.test(err.message)) return { ok: false, message: err.message };
    return { ok: false, message: `Não consegui falar com ${def.label} agora. Tente novamente.` };
  }
}
