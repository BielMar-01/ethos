process.env.ETHOS_DB = ":memory:";

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let base: string;

before(async () => {
  const { createApp } = await import("../src/app.js");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

/** Cliente mínimo que guarda o cookie de sessão. */
class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

async function registerClient(email: string, org: string) {
  const c = new Client();
  const r = await c.call("POST", "/api/auth/register", {
    name: "Usuário " + org,
    email,
    password: "senha-segura-123",
    organizationName: org,
  });
  assert.equal(r.status, 201);
  return c;
}

describe("autenticação", () => {
  it("rejeita acesso sem login", async () => {
    const r = await new Client().call("GET", "/api/properties");
    assert.equal(r.status, 401);
  });

  it("valida senha curta e e-mail duplicado", async () => {
    const c = new Client();
    const short = await c.call("POST", "/api/auth/register", { name: "A", email: "a@x.com", password: "123" });
    assert.equal(short.status, 400);
    await registerClient("dup@x.com", "Dup");
    const dup = await new Client().call("POST", "/api/auth/register", {
      name: "B",
      email: "dup@x.com",
      password: "senha-segura-123",
    });
    assert.equal(dup.status, 409);
  });

  it("login correto cria sessão e senha errada devolve 401", async () => {
    await registerClient("login@x.com", "Login");
    const ok = new Client();
    const r = await ok.call("POST", "/api/auth/login", { email: "login@x.com", password: "senha-segura-123" });
    assert.equal(r.status, 200);
    assert.equal((await ok.call("GET", "/api/auth/me")).body.role, "admin");
    const bad = await new Client().call("POST", "/api/auth/login", { email: "login@x.com", password: "errada" });
    assert.equal(bad.status, 401);
  });

  it("logout invalida a sessão", async () => {
    const c = await registerClient("out@x.com", "Out");
    await c.call("POST", "/api/auth/logout");
    const r = await c.call("GET", "/api/properties");
    assert.equal(r.status, 401);
  });
});

describe("domínio e isolamento entre organizações", () => {
  it("não lista, lê, altera nem apaga dados de outra organização", async () => {
    const a = await registerClient("a@org.com", "Org A");
    const b = await registerClient("b@org.com", "Org B");

    const created = await a.call("POST", "/api/properties", { name: "Edifício A", type: "apartamento" });
    assert.equal(created.status, 201);
    const id = created.body.item.id;

    assert.equal((await b.call("GET", "/api/properties")).body.items.length, 0);
    assert.equal((await b.call("GET", `/api/properties/${id}`)).status, 404);
    assert.equal((await b.call("PATCH", `/api/properties/${id}`, { name: "hack" })).status, 404);
    assert.equal((await b.call("DELETE", `/api/properties/${id}`)).status, 404);
    assert.equal((await a.call("GET", `/api/properties/${id}`)).body.item.name, "Edifício A");
  });

  it("ignora organization_id enviado pelo cliente", async () => {
    const a = await registerClient("c@org.com", "Org C");
    const b = await registerClient("d@org.com", "Org D");
    const me = (await b.call("GET", "/api/auth/me")).body;
    const r = await a.call("POST", "/api/owners", {
      name: "Dono",
      document: "111",
      organization_id: me.organization.id,
    });
    assert.equal(r.status, 201);
    assert.notEqual(r.body.item.organization_id, me.organization.id);
    assert.equal((await b.call("GET", "/api/owners")).body.items.length, 0);
  });

  it("não vincula unidade a imóvel de outra organização", async () => {
    const a = await registerClient("e@org.com", "Org E");
    const b = await registerClient("f@org.com", "Org F");
    const prop = (await a.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
    const r = await b.call("POST", "/api/units", { property_id: prop.id, identifier: "101" });
    assert.equal(r.status, 400);
  });

  it("não vincula proprietário de outra organização ao imóvel", async () => {
    const a = await registerClient("g@org.com", "Org G");
    const b = await registerClient("h@org.com", "Org H");
    const prop = (await a.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
    const foreignOwner = (await b.call("POST", "/api/owners", { name: "X", document: "222" })).body.item;
    const r = await a.call("PUT", `/api/properties/${prop.id}/owners`, { ownerIds: [foreignOwner.id] });
    assert.equal(r.status, 400);
    const own = (await a.call("POST", "/api/owners", { name: "Y", document: "333" })).body.item;
    const ok = await a.call("PUT", `/api/properties/${prop.id}/owners`, { ownerIds: [own.id] });
    assert.equal(ok.status, 200);
    assert.equal((await a.call("GET", `/api/properties/${prop.id}/owners`)).body.items.length, 1);
  });

  it("valida campos e impede documento duplicado na mesma organização", async () => {
    const a = await registerClient("i@org.com", "Org I");
    assert.equal((await a.call("POST", "/api/properties", { name: "P", type: "navio" })).status, 400);
    assert.equal((await a.call("POST", "/api/tenants", { name: "T" })).status, 400);
    assert.equal((await a.call("POST", "/api/tenants", { name: "T", document: "999" })).status, 201);
    assert.equal((await a.call("POST", "/api/tenants", { name: "T2", document: "999" })).status, 409);
  });

  it("unidade: status padrão, atualização e valores inválidos", async () => {
    const a = await registerClient("j@org.com", "Org J");
    const prop = (await a.call("POST", "/api/properties", { name: "P", type: "terreno" })).body.item;
    const unit = (await a.call("POST", "/api/units", { property_id: prop.id, identifier: "Casa 1", bedrooms: 2 })).body.item;
    assert.equal(unit.status, "disponivel");
    const upd = await a.call("PATCH", `/api/units/${unit.id}`, { status: "ocupada" });
    assert.equal(upd.body.item.status, "ocupada");
    assert.equal((await a.call("PATCH", `/api/units/${unit.id}`, { bedrooms: -1 })).status, 400);
    assert.equal((await a.call("POST", "/api/units", { property_id: prop.id, identifier: "Casa 1" })).status, 409);
  });

  it("apagar imóvel remove suas unidades em cascata", async () => {
    const a = await registerClient("k@org.com", "Org K");
    const prop = (await a.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
    await a.call("POST", "/api/units", { property_id: prop.id, identifier: "1" });
    assert.equal((await a.call("DELETE", `/api/properties/${prop.id}`)).status, 204);
    assert.equal((await a.call("GET", "/api/units")).body.items.length, 0);
  });
});

describe("permissões por papel", () => {
  it("/api/members é restrito a administradores e /api desconhecida dá 404 JSON", async () => {
    const a = await registerClient("l@org.com", "Org L");
    assert.equal((await a.call("GET", "/api/members")).body.members.length, 1);
    assert.equal((await new Client().call("GET", "/api/members")).status, 401);
    assert.equal((await a.call("GET", "/api/nao-existe")).status, 404);
  });

  it("papel sem permissão (inquilino) recebe 403 nos cadastros", async () => {
    const { db } = await import("../src/db.js");
    const a = await registerClient("m@org.com", "Org M");
    const me = (await a.call("GET", "/api/auth/me")).body;
    db.prepare("UPDATE organization_members SET role = 'inquilino' WHERE user_id = ?").run(me.user.id);
    assert.equal((await a.call("GET", "/api/properties")).status, 403);
    assert.equal((await a.call("GET", "/api/members")).status, 403);
  });

  it("colaborador cadastra mas não apaga", async () => {
    const { db } = await import("../src/db.js");
    const a = await registerClient("n@org.com", "Org N");
    const item = (await a.call("POST", "/api/tenants", { name: "T", document: "1" })).body.item;
    const me = (await a.call("GET", "/api/auth/me")).body;
    db.prepare("UPDATE organization_members SET role = 'colaborador' WHERE user_id = ?").run(me.user.id);
    assert.equal((await a.call("POST", "/api/tenants", { name: "T2", document: "2" })).status, 201);
    assert.equal((await a.call("DELETE", `/api/tenants/${item.id}`)).status, 403);
  });
});
