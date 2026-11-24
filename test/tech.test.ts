import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

describe("paginação opcional", () => {
  it("sem page devolve tudo (compatível); com page traz total, páginas e respeita ?q=", async () => {
    const a = await register(base, "pag1@x.com", "P1");
    for (let i = 1; i <= 7; i++) await a.call("POST", "/api/owners", { name: `Dono ${String(i).padStart(2, "0")}${i === 3 ? " Silva" : ""}`, document: `1000${i}` });
    assert.equal((await a.call("GET", "/api/owners")).body.items.length, 7);
    assert.equal((await a.call("GET", "/api/owners")).body.total, undefined, "formato antigo intacto");

    const p1 = (await a.call("GET", "/api/owners?page=1&per_page=3")).body;
    assert.deepEqual([p1.items.length, p1.total, p1.page, p1.per_page, p1.pages], [3, 7, 1, 3, 3]);
    const p3 = (await a.call("GET", "/api/owners?page=3&per_page=3")).body;
    assert.equal(p3.items.length, 1);
    assert.equal(p3.items[0].name, "Dono 07");
    assert.deepEqual((await a.call("GET", "/api/owners?page=9&per_page=3")).body.items, []);
    assert.equal((await a.call("GET", "/api/owners?page=1")).body.per_page, 50);

    const q = (await a.call("GET", "/api/owners?q=silva&page=1")).body;
    assert.equal(q.total, 1);
    assert.equal(q.items[0].name, "Dono 03 Silva");
    assert.equal((await a.call("GET", "/api/owners?q=silva")).body.items.length, 1, "busca também funciona sem paginar");
    assert.equal((await a.call("GET", "/api/owners?q=%25")).body.items.length, 0, "curinga do LIKE é escapado");
    for (const bad of ["page=0", "page=abc", "per_page=0", "per_page=201", "page=1.5"]) assert.equal((await a.call("GET", `/api/owners?${bad}`)).status, 400, bad);

    const b = await register(base, "pag2@x.com", "P2");
    assert.equal((await b.call("GET", "/api/owners?page=1")).body.total, 0, "isolado por organização");
  });

  it("cobranças e pagamentos paginam", async () => {
    const a = await register(base, "pag3@x.com", "P3");
    const owner = (await a.call("POST", "/api/owners", { name: "D", document: "1" })).body.item;
    const prop = (await a.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
    await a.call("PUT", `/api/properties/${prop.id}/owners`, { ownerIds: [owner.id] });
    const unit = (await a.call("POST", "/api/units", { property_id: prop.id, identifier: "U" })).body.item;
    const ten = (await a.call("POST", "/api/tenants", { name: "T", document: "2" })).body.item;
    const lease = (await a.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [ten.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
    await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
    for (const m of ["2024-01", "2024-02", "2024-03", "2024-04"]) await a.call("POST", "/api/charges/generate", { month: m });
    const all = (await a.call("GET", "/api/charges")).body.items;
    assert.equal(all.length, 4);
    const pg = (await a.call("GET", "/api/charges?page=2&per_page=3")).body;
    assert.deepEqual([pg.items.length, pg.total, pg.pages], [1, 4, 2]);
    assert.equal((await a.call("GET", "/api/charges?status=vencida&page=1&per_page=2")).body.total, 4);
    for (let i = 0; i < 3; i++) await a.call("POST", "/api/payments", { lease_id: lease.id, received_at: "2024-03-10", amount_cents: 1000, method: "pix", allocations: [{ charge_id: all[i].id, amount_cents: 1000 }] });
    const pp = (await a.call("GET", "/api/payments?page=1&per_page=2")).body;
    assert.deepEqual([pp.items.length, pp.total, pp.pages], [2, 3, 2]);
    assert.equal((await a.call("GET", "/api/payments?page=x")).status, 400);
  });
});

describe("monitoramento de erros", () => {
  it("guarda erros do navegador sem query string, limita abuso e só o admin lê e limpa", async () => {
    const a = await register(base, "mon1@x.com", "M1");
    const anon = new Client(base);
    assert.equal((await anon.call("POST", "/api/client-errors", {})).status, 400);
    const ok = await a.call("POST", "/api/client-errors", { message: "TypeError: x is undefined", stack: "at foo (app.js:1:1)", url: "/painel?token=segredo#hash" });
    assert.equal(ok.status, 204);
    const list = (await a.call("GET", "/api/admin/errors")).body;
    assert.equal(list.items[0].message, "TypeError: x is undefined");
    assert.equal(list.items[0].path, "/painel", "query string e hash nunca são guardados");
    assert.ok(!JSON.stringify(list).includes("segredo"));
    assert.ok(list.last_24h.client >= 1);

    assert.equal((await anon.call("GET", "/api/admin/errors")).status, 401);
    const inv = await a.call("POST", "/api/invitations", { email: "col-mon1@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${new URL(inv.body.link).searchParams.get("invite")}/accept`, { name: "Col", password: "senha-segura-123" });
    assert.equal((await col.call("GET", "/api/admin/errors")).status, 403);

    let last = 0;
    for (let i = 0; i < 22; i++) last = (await anon.call("POST", "/api/client-errors", { message: `erro ${i}` })).status;
    assert.equal(last, 429, "limite por IP");
    assert.equal((await a.call("DELETE", "/api/admin/errors")).status, 204);
    assert.equal((await a.call("GET", "/api/admin/errors")).body.items.length, 0);
  });

  it("erro do servidor é registrado (sem corpo) e uma enxurrada avisa os administradores por e-mail, no máximo 1 vez/hora", async () => {
    const { captureServerError } = await import("../src/monitoring.js");
    const { memoryMailer } = await import("../src/mailer.js");
    const a = await register(base, "mon2@x.com", "M2");
    process.env.ERROR_ALERT_EMAILS = "operador@plataforma.com, invalido";
    const fake = { method: "POST", originalUrl: "/api/algo?senha=123" } as never;
    for (let i = 0; i < 12; i++) await captureServerError(new Error(`falha ${i}`), fake);
    const list = (await a.call("GET", "/api/admin/errors")).body.items as { source: string; path: string; method: string }[];
    assert.ok(list.some((e) => e.source === "server" && e.path === "/api/algo" && e.method === "POST"));
    assert.ok(!JSON.stringify(list).includes("senha=123"));
    const alerts = () => memoryMailer.outbox.filter((m) => m.to === "operador@plataforma.com" && m.subject === "Ethos: muitos erros no servidor").length;
    assert.equal(alerts(), 1, "a enxurrada avisou quem opera");
    assert.equal(memoryMailer.outbox.filter((m) => m.to === "mon2@x.com" && m.subject === "Ethos: muitos erros no servidor").length, 0, "administradores de organizações não recebem");
    for (let i = 0; i < 5; i++) await captureServerError(new Error("mais"), fake);
    assert.equal(alerts(), 1, "sem repetir dentro de 1 hora");
    delete process.env.ERROR_ALERT_EMAILS;
  });
});

describe("chaves de API: leituras sensíveis ficam de fora", () => {
  it("relatórios gerenciais podem ser lidos; análise de crédito, extrato, DIMOB e arquivos não", async () => {
    const a = await register(base, "key1@x.com", "K1");
    const token = (await a.call("POST", "/api/api-keys", { name: "n8n" })).body.token;
    const get = (p: string) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await get("/api/reports/kpis")).status, 200);
    assert.equal((await get("/api/reports/delinquency")).status, 200);
    for (const p of ["/api/credit-checks", "/api/bank/lines", "/api/reports/dimob?year=2026", "/api/reports/owner-income?year=2026&owner_id=1", "/api/visitors/1/photo", "/api/property-documents/1/file", "/api/documents/1/signature", "/api/settings/public-listing"]) {
      assert.equal((await get(p)).status, 403, `${p} não é para chaves`);
    }
    assert.equal((await fetch(`${base}/api/leads`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })).status, 403, "chaves nunca escrevem");
  });
});
