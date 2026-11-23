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

describe("dados de demonstração", () => {
  it("popula uma organização vazia de forma consistente e recusa uma segunda vez", async () => {
    const admin = await register(base, "demo@x.com", "Demo");
    const me = (await admin.call("GET", "/api/auth/me")).body;
    const { seedDemo } = await import("../src/demo.js");

    const summary = await seedDemo(me.organization.id, me.user.id);
    assert.equal(summary.properties, 2);
    assert.equal(summary.leases, 4);
    assert.ok(summary.charges >= 8, "ao menos dois meses vencidos de 4 contratos");
    assert.ok(summary.payments > 0);
    assert.equal(summary.invites.length, 2);

    // Dados e regras reais: contratos vigentes, unidade livre, recibos numerados, repasses calculados.
    const leases = (await admin.call("GET", "/api/leases")).body.items;
    assert.equal(leases.filter((l: { status: string }) => l.status === "vigente").length, 4);
    const units = (await admin.call("GET", "/api/units")).body.items;
    assert.equal(units.filter((u: { status: string }) => u.status === "disponivel").length, 1);
    const payments = (await admin.call("GET", "/api/payments")).body.items;
    const numbers = payments.map((p: { receipt_number: number }) => p.receipt_number).sort((a: number, b: number) => a - b);
    assert.deepEqual(numbers, numbers.map((_: number, i: number) => i + 1), "recibos sequenciais sem buracos");
    assert.ok((await admin.call("GET", "/api/transfers")).body.items.length > 0);
    assert.equal((await admin.call("GET", "/api/documents/1")).status, 200);

    // As cobranças geradas sempre batem com os pagamentos (a soma das baixas = valor pago).
    const charges = (await admin.call("GET", "/api/charges")).body.items;
    const paid = charges.reduce((s: number, c: { paid_cents: number }) => s + c.paid_cents, 0);
    const received = payments.reduce((s: number, p: { amount_cents: number }) => s + p.amount_cents, 0);
    assert.equal(paid, received);

    // Há pelo menos uma cobrança em atraso para o painel mostrar algo.
    assert.ok(charges.some((c: { status: string }) => c.status === "vencida"));

    // Os convites de demonstração funcionam e levam à área do cliente.
    const token = new URL(summary.invites[0]!.link).searchParams.get("invite");
    const tenant = new Client(base);
    const accepted = await tenant.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Carlos", password: "senha-segura-123" });
    assert.equal(accepted.status, 201);
    assert.ok((await tenant.call("GET", "/api/portal/tenant/charges")).body.items.length >= 3);

    // Segunda execução: recusa (nunca sobrescreve) e não deixa sessão temporária para trás.
    await assert.rejects(() => seedDemo(me.organization.id, me.user.id), /já tem imóveis/);
    const { db } = await import("../src/db.js");
    const sessions = await db.query("SELECT 1 FROM sessions WHERE user_id = $1", [me.user.id]);
    assert.equal(sessions.length, 1, "só a sessão de login do admin; a temporária do seed foi apagada");
  });
});
