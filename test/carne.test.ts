import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

async function world(tag: string, rent = 100000) {
  const c = await register(base, `cn${tag}@x.com`, `CN ${tag}`);
  const owner = (await c.call("POST", "/api/owners", { name: "Dono", document: `9${tag}` })).body.item;
  const prop = (await c.call("POST", "/api/properties", { name: "Prédio", type: "apartamento" })).body.item;
  await c.call("PUT", `/api/properties/${prop.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await c.call("POST", "/api/units", { property_id: prop.id, identifier: "U" })).body.item;
  const ten = (await c.call("POST", "/api/tenants", { name: "Inquilino", document: `8${tag}` })).body.item;
  const lease = (await c.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [ten.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: rent, due_day: 5 })).body.lease;
  await c.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  return { c, leaseId: lease.id as number };
}

describe("carnê do contrato e baixa em lote (manual, sem integração)", () => {
  it("gera de uma vez os aluguéis e os boletos de vários meses do contrato, sem duplicar", async () => {
    const w = await world("1");
    const bad = (b: Record<string, unknown>) => w.c.call("POST", `/api/leases/${w.leaseId}/carne`, b);
    assert.equal((await bad({})).status, 400);
    assert.equal((await bad({ from: "2024-06", to: "2024-01" })).status, 400);
    assert.equal((await bad({ from: "2020-01", to: "2030-12" })).status, 400, "mais de 36 meses");
    assert.equal((await w.c.call("POST", "/api/leases/999999/carne", { from: "2024-01", to: "2024-02" })).status, 404);

    const r = await bad({ from: "2024-01", to: "2024-06" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.months, r.body.charges_created, r.body.boletos_created, r.body.failed.length], [6, 6, 6, 0]);
    const list = (await w.c.call("GET", "/api/boletos")).body.items as { provider: string; status: string; amount_cents: number }[];
    assert.equal(list.length, 6);
    assert.ok(list.every((b) => b.provider === "manual" && b.amount_cents === 100000));

    const again = await bad({ from: "2024-01", to: "2024-06" });
    assert.deepEqual([again.body.charges_created, again.body.boletos_created], [0, 0], "idempotente");
    const more = await bad({ from: "2024-01", to: "2024-08" });
    assert.deepEqual([more.body.charges_created, more.body.boletos_created], [2, 2], "só os meses novos");

    const other = await world("2");
    assert.equal((await other.c.call("POST", `/api/leases/${w.leaseId}/carne`, { from: "2024-01", to: "2024-02" })).status, 404, "isolado por organização");
    assert.equal((await new Client(base).call("POST", `/api/leases/${w.leaseId}/carne`, {})).status, 401);
  });

  it("só gera para contrato vigente e pode usar cobranças já existentes (generate_charges=false)", async () => {
    const w = await world("3");
    await w.c.call("POST", "/api/charges/generate", { month: "2024-03" });
    const r = await w.c.call("POST", `/api/leases/${w.leaseId}/carne`, { from: "2024-01", to: "2024-04", generate_charges: false });
    assert.deepEqual([r.body.charges_created, r.body.boletos_created], [0, 1], "só a cobrança que já existia");
    await w.c.call("POST", `/api/leases/${w.leaseId}/status`, { status: "encerrado" });
    assert.equal((await w.c.call("POST", `/api/leases/${w.leaseId}/carne`, { from: "2024-01", to: "2024-02" })).status, 409);
  });

  it("baixa em lote por contrato, por mês ou por lista; cada um no próprio vencimento; com recibo", async () => {
    const w = await world("4");
    await w.c.call("POST", `/api/leases/${w.leaseId}/carne`, { from: "2024-01", to: "2024-04" });
    const bad = (b: Record<string, unknown>) => w.c.call("POST", "/api/boletos/paid-bulk", b);
    assert.equal((await bad({})).status, 400);
    assert.equal((await bad({ boleto_ids: [] })).status, 400);
    assert.equal((await bad({ month: "2024-13" })).status, 400);
    assert.equal((await bad({ lease_id: 0 })).status, 400);

    // Um mês só, no vencimento de cada um, só marcando.
    const jan = await bad({ month: "2024-01", use_due_date: true });
    assert.deepEqual([jan.body.eligible, jan.body.paid, jan.body.payments, jan.body.failed.length], [1, 1, 0, 0]);
    const paid = (await w.c.call("GET", "/api/boletos?status=paga")).body.items[0];
    assert.equal(String(paid.paid_at).slice(0, 10), "2024-01-05", "baixou no vencimento");
    const charges1 = (await w.c.call("GET", "/api/charges?month=2024-01")).body.items;
    assert.equal(charges1[0].status, "vencida", "sem registrar recebimento a cobrança não é baixada");

    // O resto do contrato, já registrando o recebimento (recibo + baixa).
    const rest = await bad({ lease_id: w.leaseId, use_due_date: true, register_payment: true });
    assert.deepEqual([rest.body.eligible, rest.body.paid, rest.body.payments], [3, 3, 3]);
    const charges = (await w.c.call("GET", "/api/charges")).body.items as { status: string; due_date: string }[];
    assert.equal(charges.filter((c) => c.status === "paga").length, 3);
    const pays = (await w.c.call("GET", "/api/payments")).body.items as { method: string; received_at: string; receipt_number: number }[];
    assert.equal(pays.length, 3);
    assert.ok(pays.every((p) => p.method === "boleto" && p.receipt_number >= 1));
    assert.deepEqual(pays.map((p) => String(p.received_at).slice(0, 10)).sort(), ["2024-02-05", "2024-03-05", "2024-04-05"]);

    // Nada mais a baixar; repetir não faz nada.
    assert.deepEqual([(await bad({ lease_id: w.leaseId })).body.eligible], [0]);
  });

  it("baixa por lista de ids: ignora pagos, respeita data futura e isola organizações", async () => {
    const w = await world("5");
    await w.c.call("POST", `/api/leases/${w.leaseId}/carne`, { from: "2024-01", to: "2024-02" });
    const ids = ((await w.c.call("GET", "/api/boletos")).body.items as { id: number }[]).map((b) => b.id);
    assert.equal((await w.c.call("POST", "/api/boletos/paid-bulk", { boleto_ids: ids, paid_at: "2999-01-01" })).body.failed.length, 2, "data no futuro é recusada");
    const ok = await w.c.call("POST", "/api/boletos/paid-bulk", { boleto_ids: [ids[0]], paid_at: "2024-03-01", register_payment: true });
    assert.deepEqual([ok.body.paid, ok.body.payments], [1, 1]);
    const twice = await w.c.call("POST", "/api/boletos/paid-bulk", { boleto_ids: ids, paid_at: "2024-03-01" });
    assert.deepEqual([twice.body.paid, twice.body.failed.length], [1, 1], "o já pago falha sozinho");
    const other = await world("6");
    const x = await other.c.call("POST", "/api/boletos/paid-bulk", { boleto_ids: ids });
    assert.deepEqual([x.body.paid, x.body.failed.length], [0, ids.length], "boletos de outra organização não existem para ela");
  });
});

describe("pré-visualização da baixa em lote", () => {
  it("dry_run lista o que seria baixado sem baixar nada", async () => {
    const w = await world("7");
    await w.c.call("POST", `/api/leases/${w.leaseId}/carne`, { from: "2024-01", to: "2024-03" });
    const prev = await w.c.call("POST", "/api/boletos/paid-bulk", { lease_id: w.leaseId, dry_run: true });
    assert.equal(prev.body.eligible, 3);
    assert.equal(prev.body.items.length, 3);
    assert.equal(prev.body.items[0].status, "vencida");
    assert.equal((await w.c.call("GET", "/api/boletos?status=paga")).body.items.length, 0, "nada foi baixado");
  });
});
