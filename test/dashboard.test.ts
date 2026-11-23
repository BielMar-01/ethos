import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

describe("painel (dashboard)", () => {
  it("organização vazia devolve zeros", async () => {
    const a = await register(base, "dash-empty@x.com", "Vazia");
    const r = await a.call("GET", "/api/dashboard");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.counts.units, { total: 0, occupied: 0, available: 0 });
    assert.equal(r.body.counts.leases.active, 0);
    assert.equal(r.body.finance.expected_cents, 0);
    assert.deepEqual(r.body.attention, []);
    assert.match(r.body.month, /^\d{4}-\d{2}$/);
  });

  it("resume a operação e destaca o que pede atenção", async () => {
    const a = await register(base, "dash@x.com", "Painel");
    const b = await register(base, "dash-b@x.com", "Outra");
    const property = (await a.call("POST", "/api/properties", { name: "Edifício Painel", type: "apartamento" })).body.item;
    const u1 = (await a.call("POST", "/api/units", { property_id: property.id, identifier: "101" })).body.item;
    await a.call("POST", "/api/units", { property_id: property.id, identifier: "102" });
    const tenant = (await a.call("POST", "/api/tenants", { name: "Inq", document: "1" })).body.item;
    const lease = (await a.call("POST", "/api/leases", { unit_id: u1.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
    await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
    await a.call("POST", "/api/charges/generate", { month: "2024-03" }); // vencida
    await a.call("POST", "/api/maintenance", { unit_id: u1.id, category: "eletrica", title: "Curto-circuito", description: "Cheiro de queimado", priority: "urgente" });
    await a.call("POST", "/api/inspections", { unit_id: u1.id, type: "periodica", scheduled_for: "2030-01-10" });

    const d = (await a.call("GET", "/api/dashboard")).body;
    assert.equal(d.counts.properties, 1);
    assert.deepEqual(d.counts.units, { total: 2, occupied: 1, available: 1 });
    assert.equal(d.counts.leases.active, 1);
    assert.equal(d.counts.maintenance.open, 1);
    assert.equal(d.counts.maintenance.urgent, 1);
    assert.equal(d.counts.inspections_pending, 1);
    assert.equal(d.finance.overdue_cents, 100000, "atraso de meses anteriores aparece no painel");
    assert.equal(d.finance.overdue_count, 1);

    assert.equal(d.attention[0].title, "Curto-circuito", "urgente primeiro");
    assert.equal(d.attention[0].link_kind, "maintenance");
    assert.ok(d.attention.some((i: { kind: string; title: string }) => i.kind === "inspection" && /periodica/.test(i.title)));

    const other = (await b.call("GET", "/api/dashboard")).body;
    assert.equal(other.counts.properties, 0, "isolado por organização");
    assert.deepEqual(other.attention, []);
  });

  it("só a equipe acessa; chave de API lê", async () => {
    const a = await register(base, "dash-perm@x.com", "Perm");
    assert.equal((await new Client(base).call("GET", "/api/dashboard")).status, 401);
    const { db } = await import("../src/db.js");
    const key = (await a.call("POST", "/api/api-keys", { name: "painel" })).body.token;
    const viaKey = await fetch(base + "/api/dashboard", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(viaKey.status, 200);
    const me = (await a.call("GET", "/api/auth/me")).body;
    await db.query("UPDATE organization_members SET role = 'inquilino' WHERE user_id = $1", [me.user.id]);
    assert.equal((await a.call("GET", "/api/dashboard")).status, 403);
  });
});
