import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, register, startServer, tokenFrom } from "./helpers.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

interface Row { kind: string; summary: string; user_email: string; entity: string; entity_id: number | null; status: number; metadata: Record<string, unknown> }

/** O registro é gravado logo após a resposta: espera até aparecer (ou estoura). */
async function logs(admin: Client, query = ""): Promise<Row[]> {
  for (let i = 0; i < 40; i++) {
    const r = await admin.call("GET", `/api/audit${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.items.length > 0 || i === 39) return r.body.items;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  return [];
}
const settle = () => new Promise((ok) => setTimeout(ok, 150));

describe("auditoria", () => {
  it("registra cadastros, alterações e exclusões com autor, alvo e nome legível", async () => {
    const a = await register(base, "aud@x.com", "Aud");
    const created = (await a.call("POST", "/api/owners", { name: "Maria Souza", document: "1" })).body.item;
    await a.call("PATCH", `/api/owners/${created.id}`, { name: "Maria S. Souza", document: "1" });
    await a.call("DELETE", `/api/owners/${created.id}`);
    await settle();
    const items = await logs(a, "?entity=owners");
    assert.deepEqual(items.map((i) => i.kind).reverse(), ["create", "update", "delete"]);
    const create = items.find((i) => i.kind === "create")!;
    assert.match(create.summary, /Cadastrou proprietário — Maria Souza/);
    assert.equal(create.entity_id, created.id);
    assert.equal(create.user_email, "aud@x.com");
    assert.equal(create.status, 201);
  });

  it("registra login, login falho e logout; nunca grava senha", async () => {
    const a = await register(base, "aud-login@x.com", "AudLogin");
    const other = new Client(base);
    await other.call("POST", "/api/auth/login", { email: "aud-login@x.com", password: "errada-errada" });
    const ok = new Client(base);
    await ok.call("POST", "/api/auth/login", { email: "aud-login@x.com", password: PASSWORD });
    await ok.call("POST", "/api/auth/logout");
    await settle();
    const items = await logs(a, "?kind=auth");
    const text = items.map((i) => i.summary).join("|");
    assert.match(text, /Entrou no sistema/);
    assert.match(text, /senha incorreta/);
    assert.match(text, /Saiu do sistema/);
    assert.ok(!JSON.stringify(items).includes(PASSWORD), "a senha não pode aparecer no registro");
  });

  it("registra ações de negócio com o detalhe (status, mês) e as negações 403", async () => {
    const a = await register(base, "aud-biz@x.com", "AudBiz");
    await a.call("POST", "/api/charges/generate", { month: "2024-03" });
    const r = await a.call("POST", "/api/invitations", { email: "col-aud@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${tokenFrom(r.body.link)}/accept`, { name: "Col", password: PASSWORD });
    assert.equal((await col.call("POST", "/api/reminders/run")).status, 403);
    await settle();
    const items = await logs(a);
    const gen = items.find((i) => /Gerou cobranças/.test(i.summary))!;
    assert.equal(gen.metadata.month, "2024-03");
    assert.ok(items.some((i) => i.kind === "denied" && i.user_email === "col-aud@x.com"), "negação registrada");
    assert.ok(items.some((i) => /Aceitou um convite/.test(i.summary) && i.user_email === "col-aud@x.com"));
  });

  it("só o administrador lê; colaborador, anônimo e outra organização não", async () => {
    const a = await register(base, "aud-perm@x.com", "AudPerm");
    const b = await register(base, "aud-perm-b@x.com", "AudPermB");
    const r = await a.call("POST", "/api/invitations", { email: "col-perm@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${tokenFrom(r.body.link)}/accept`, { name: "Col", password: PASSWORD });
    assert.equal((await col.call("GET", "/api/audit")).status, 403);
    assert.equal((await col.call("GET", "/api/audit/export")).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/audit")).status, 401);
    await a.call("POST", "/api/owners", { name: "Só da A", document: "1" });
    await settle();
    const doB = await logs(b);
    assert.ok(doB.every((i) => !/Só da A/.test(i.summary)), "isolado por organização");
    assert.equal((await a.call("DELETE", "/api/audit/1")).status, 404, "não há rota para apagar");
  });

  it("filtra por texto, tipo e data; pagina por cursor; valida entradas", async () => {
    const a = await register(base, "aud-filter@x.com", "AudFilter");
    for (let i = 0; i < 5; i++) await a.call("POST", "/api/owners", { name: `Pessoa ${i}`, document: String(i) });
    await settle();
    const page1 = (await a.call("GET", "/api/audit?limit=3")).body;
    assert.equal(page1.items.length, 3);
    assert.ok(page1.next_before);
    const page2 = (await a.call("GET", `/api/audit?limit=3&before=${page1.next_before}`)).body;
    assert.ok(page2.items.every((i: { id: number }) => i.id < page1.next_before));
    assert.equal((await a.call("GET", "/api/audit?q=Pessoa 3")).body.items.length, 1);
    assert.equal((await a.call("GET", "/api/audit?q=%25")).body.items.length, 0, "% é literal, não curinga");
    assert.equal((await a.call("GET", "/api/audit?kind=denied")).body.items.length, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await a.call("GET", `/api/audit?from=${today}&to=${today}`)).body.items.length >= 5);
    assert.equal((await a.call("GET", "/api/audit?from=2020-01-01&to=2020-01-02")).body.items.length, 0);
    assert.equal((await a.call("GET", "/api/audit?kind=xx")).status, 400);
    assert.equal((await a.call("GET", "/api/audit?from=ontem")).status, 400);
    assert.equal((await a.call("GET", "/api/audit/actors")).body.items.length, 1);
  });

  it("exporta CSV protegido contra injeção de fórmula", async () => {
    const a = await register(base, "aud-csv@x.com", "AudCsv");
    await a.call("POST", "/api/owners", { name: "=HYPERLINK(\"x\")", document: "1" });
    await settle();
    const res = await fetch(`${base}/api/audit/export`, { headers: { Cookie: a.cookie } });
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    const text = await res.text();
    assert.match(text, /Data\/hora/);
    assert.ok(text.includes("'=HYPERLINK") || !text.includes(',"=HYPERLINK'), "fórmula neutralizada");
  });
});
