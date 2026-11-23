import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { Client, PASSWORD, register, startServer, tokenFrom, upload } from "./helpers.js";
import { setAnthropicTestClient } from "../src/integrations.js";
import { setExtractClientFactory } from "../src/extract.js";
import { decryptSecret, encryptSecret } from "../src/secrets.js";

let base: string;
let close: () => Promise<void>;
const realFetch = globalThis.fetch;
let asaasStatus = 200;
const asaasCalls: { url: string; token: string }[] = [];
const ASAAS_KEY = "$aact_prod_000000000000000000000000000000000abcd";
const ANT_KEY = "sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyz";

before(async () => {
  process.env.INTEGRATIONS_SECRET = "segredo-de-teste-com-mais-de-32-caracteres";
  ({ base, close } = await startServer());
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("asaas.com")) {
      asaasCalls.push({ url, token: String((init?.headers as Record<string, string>)?.access_token) });
      return new Response(JSON.stringify({ balance: 0 }), { status: asaasStatus });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  setAnthropicTestClient(null);
  setExtractClientFactory(null);
  await close();
});

describe("cifra de segredos", () => {
  it("cifra e decifra; adulterar o texto cifrado falha; cada cifra é diferente", () => {
    const a = encryptSecret("minha-chave");
    const b = encryptSecret("minha-chave");
    assert.notEqual(a, b, "IV aleatório");
    assert.equal(decryptSecret(a), "minha-chave");
    assert.ok(!a.includes("minha-chave"));
    const [v, iv, tag, data] = a.split(".");
    const tampered = [v, iv, tag, Buffer.from("xx" + Buffer.from(data!, "base64url").toString("latin1")).toString("base64url")].join(".");
    assert.throws(() => decryptSecret(tampered));
  });
});

describe("integrações (Asaas e IA)", () => {
  it("guarda a chave cifrada, devolve só o final e nunca a chave inteira", async () => {
    const a = await register(base, "int@x.com", "Int");
    const r = await a.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY, environment: "production", enabled: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.integration.hint, "abcd");
    assert.equal(r.body.integration.config.environment, "production");
    const get = await a.call("GET", "/api/integrations");
    assert.ok(!JSON.stringify(get.body).includes(ASAAS_KEY), "a chave não volta");
    assert.equal(get.body.asaas.configured, true);
    assert.equal(get.body.secrets_ready, true);
    // No banco está cifrada.
    const { db } = await import("../src/db.js");
    const [row] = await db.query<{ secret_enc: string }>("SELECT secret_enc FROM integrations WHERE provider = 'asaas' AND secret_enc IS NOT NULL ORDER BY id DESC LIMIT 1");
    assert.ok(row!.secret_enc.startsWith("v1.") && !row!.secret_enc.includes("aact"));
    assert.equal(decryptSecret(row!.secret_enc), ASAAS_KEY);
  });

  it("alterar sem enviar a chave mantém a atual; valida ambiente e formato", async () => {
    const a = await register(base, "int2@x.com", "Int2");
    assert.equal((await a.call("PUT", "/api/integrations/asaas", { environment: "sandbox" })).status, 400, "sem chave ainda");
    assert.equal((await a.call("PUT", "/api/integrations/asaas", { api_key: "curta", environment: "sandbox" })).status, 400);
    assert.equal((await a.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY, environment: "lua" })).status, 400);
    await a.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY, environment: "sandbox" });
    const again = await a.call("PUT", "/api/integrations/asaas", { environment: "production", enabled: false });
    assert.equal(again.body.integration.hint, "abcd", "manteve a chave");
    assert.equal(again.body.integration.enabled, false);
    assert.equal((await a.call("PUT", "/api/integrations/whatsapp", { api_key: "x" })).status, 404);
    assert.equal((await a.call("PUT", "/api/integrations/anthropic", { api_key: "chave-errada-sem-prefixo-1234567890" })).status, 400);
    assert.equal((await a.call("PUT", "/api/integrations/anthropic", { api_key: ANT_KEY, model: "gpt-4" })).status, 400);
  });

  it("testa a conexão com o Asaas: ok, chave recusada e ambiente certo; grava o resultado", async () => {
    const a = await register(base, "int3@x.com", "Int3");
    assert.equal((await a.call("POST", "/api/integrations/asaas/test")).status, 409, "sem chave");
    await a.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY, environment: "sandbox" });
    asaasStatus = 200;
    const ok = await a.call("POST", "/api/integrations/asaas/test");
    assert.equal(ok.body.ok, true);
    assert.match(asaasCalls.at(-1)!.url, /api-sandbox\.asaas\.com\/v3\/finance\/balance/);
    assert.equal(asaasCalls.at(-1)!.token, ASAAS_KEY);
    assert.equal((await a.call("GET", "/api/integrations")).body.asaas.last_status, "ok");
    asaasStatus = 401;
    const bad = await a.call("POST", "/api/integrations/asaas/test");
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.message, /recusou a chave/);
    const g = (await a.call("GET", "/api/integrations")).body.asaas;
    assert.equal(g.last_status, "error");
    asaasStatus = 200;
    await a.call("PUT", "/api/integrations/asaas", { environment: "production" });
    await a.call("POST", "/api/integrations/asaas/test");
    assert.match(asaasCalls.at(-1)!.url, /\/\/api\.asaas\.com\/v3/);
  });

  it("IA da organização: teste de conexão e a leitura de documentos passa a usar a chave dela", async () => {
    const a = await register(base, "int4@x.com", "Int4");
    setAnthropicTestClient(() => ({ models: { list: async () => ({}) } }) as never);
    await a.call("PUT", "/api/integrations/anthropic", { api_key: ANT_KEY, model: "claude-sonnet-5-5" });
    assert.equal((await a.call("POST", "/api/integrations/anthropic/test")).body.ok, true);
    setAnthropicTestClient(() => ({ models: { list: async () => { throw new Anthropic.AuthenticationError(401, {}, "x", new Headers()); } } }) as never);
    assert.match((await a.call("POST", "/api/integrations/anthropic/test")).body.message, /recusou a chave/);

    // Sem chave no servidor, só a da organização liga a leitura — e o modelo escolhido vai junto.
    delete process.env.ANTHROPIC_API_KEY;
    const seen: { key?: string; model?: unknown }[] = [];
    setExtractClientFactory((key) => ({ beta: { messages: { create: async (p: Record<string, unknown>) => { seen.push({ key, model: p.model }); return { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }; } } } }) as never);
    const st = await a.call("GET", "/api/extract/status");
    assert.deepEqual([st.body.enabled, st.body.source], [true, "organization"]);
    const r = await upload(a, "/api/extract", Buffer.from("%PDF-1.4 x"), "application/pdf");
    assert.equal(r.status, 200);
    assert.deepEqual(seen[0], { key: ANT_KEY, model: "claude-sonnet-5-5" });

    // Desligada na organização e sem chave do servidor: volta a ficar desligada.
    await a.call("PUT", "/api/integrations/anthropic", { enabled: false });
    assert.equal((await a.call("GET", "/api/extract/status")).body.enabled, false);
    // Chave do servidor entra como reserva.
    process.env.ANTHROPIC_API_KEY = "sk-ant-servidor-0123456789abcdefghij";
    assert.deepEqual([(await a.call("GET", "/api/extract/status")).body.source], ["server"]);
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("só admin; isolado por organização; desconectar remove; ações entram no registro sem a chave", async () => {
    const a = await register(base, "int5@x.com", "Int5");
    const b = await register(base, "int5b@x.com", "Int5B");
    await a.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY, environment: "sandbox" });
    assert.equal((await b.call("GET", "/api/integrations")).body.asaas.configured, false, "outra organização não vê");
    const inv = await a.call("POST", "/api/invitations", { email: "col-int@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { name: "C", password: PASSWORD });
    assert.equal((await col.call("GET", "/api/integrations")).status, 403);
    assert.equal((await col.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY })).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/integrations")).status, 401);

    await new Promise((r) => setTimeout(r, 200));
    const logs = (await a.call("GET", "/api/audit")).body.items;
    assert.ok(logs.some((l: { summary: string }) => /Configurou uma integração/.test(l.summary)));
    assert.ok(!JSON.stringify(logs).includes("aact_prod"), "a chave nunca vai para o registro");

    assert.equal((await a.call("DELETE", "/api/integrations/asaas")).status, 204);
    assert.equal((await a.call("GET", "/api/integrations")).body.asaas.configured, false);
  });

  it("sem INTEGRATIONS_SECRET recusa guardar chave", async () => {
    const a = await register(base, "int6@x.com", "Int6");
    const saved = process.env.INTEGRATIONS_SECRET;
    delete process.env.INTEGRATIONS_SECRET;
    const r = await a.call("PUT", "/api/integrations/asaas", { api_key: ASAAS_KEY, environment: "sandbox" });
    const status = (await a.call("GET", "/api/integrations")).body.secrets_ready;
    process.env.INTEGRATIONS_SECRET = saved;
    assert.equal(r.status, 409);
    assert.equal(status, false);
  });
});
