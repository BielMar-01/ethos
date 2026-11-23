import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, register, startServer, tokenFrom } from "./helpers.js";
import { clearCepCache } from "../src/cep.js";

let base: string;
let close: () => Promise<void>;
const realFetch = globalThis.fetch;
const calls: string[] = [];
let viacep: (cep: string) => Response = () => new Response("{}", { status: 500 });
let brasil: (cep: string) => Response = () => new Response("{}", { status: 500 });

before(async () => {
  ({ base, close } = await startServer());
  // Intercepta só os provedores de CEP; o resto (o próprio servidor de teste) passa direto.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const m = /viacep\.com\.br\/ws\/(\d+)\/json/.exec(url);
    if (m) return viacep(m[1]!);
    const b = /brasilapi\.com\.br\/api\/cep\/v1\/(\d+)/.exec(url);
    if (b) return brasil(b[1]!);
    return realFetch(input, init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  await close();
});
beforeEach(() => {
  calls.length = 0;
  clearCepCache();
  viacep = () => new Response("{}", { status: 500 });
  brasil = () => new Response("{}", { status: 500 });
});

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

describe("consulta de CEP", () => {
  it("preenche o endereço pelo ViaCEP, aceita máscara e usa cache", async () => {
    viacep = () => json({ cep: "01001-000", logradouro: "Praça da Sé", complemento: "lado ímpar", bairro: "Sé", localidade: "São Paulo", uf: "sp" });
    const a = await register(base, "cep@x.com", "Cep");
    const r = await a.call("GET", "/api/cep/01001-000");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { zip: "01001-000", street: "Praça da Sé", neighborhood: "Sé", city: "São Paulo", state: "SP", complement: "lado ímpar" });
    await a.call("GET", "/api/cep/01001000");
    assert.equal(calls.filter((c) => c.includes("viacep")).length, 1, "segunda consulta veio do cache");
  });

  it("CEP inexistente é 404 amigável; formato inválido é 400", async () => {
    viacep = () => json({ erro: true });
    brasil = () => json({ message: "nf" }, 404);
    const a = await register(base, "cep2@x.com", "Cep2");
    const nf = await a.call("GET", "/api/cep/99999999");
    assert.equal(nf.status, 404);
    assert.match(nf.body.error, /não encontrado/);
    assert.equal((await a.call("GET", "/api/cep/123")).status, 400);
    assert.equal((await a.call("GET", "/api/cep/abcdefgh")).status, 400);
  });

  it("se o ViaCEP cai, usa a BrasilAPI; se os dois caem, 502 sem quebrar", async () => {
    brasil = () => json({ cep: "20040020", street: "Rua da Assembleia", neighborhood: "Centro", city: "Rio de Janeiro", state: "RJ" });
    const a = await register(base, "cep3@x.com", "Cep3");
    const r = await a.call("GET", "/api/cep/20040020");
    assert.equal(r.status, 200);
    assert.equal(r.body.city, "Rio de Janeiro");
    clearCepCache();
    brasil = () => new Response("x", { status: 503 });
    const down = await a.call("GET", "/api/cep/20040020");
    assert.equal(down.status, 502);
    assert.match(down.body.error, /manualmente/);
  });

  it("exige login de equipe", async () => {
    viacep = () => json({ cep: "01001-000", logradouro: "X", bairro: "Y", localidade: "Z", uf: "SP" });
    const a = await register(base, "cep4@x.com", "Cep4");
    assert.equal((await new Client(base).call("GET", "/api/cep/01001000")).status, 401);
    const tenantId = (await a.call("POST", "/api/tenants", { name: "T", document: "7" })).body.item.id;
    const inv = await a.call("POST", "/api/invitations", { email: "cep-inq@x.com", role: "inquilino", tenantId });
    const inq = new Client(base);
    await inq.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { name: "I", password: PASSWORD });
    assert.equal((await inq.call("GET", "/api/cep/01001000")).status, 403);
  });
});
