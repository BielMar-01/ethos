import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

const FUTURE = "2030-06";
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const PAST = "2024-03";

async function memberClient(admin: Client, email: string, role: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const inv = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  assert.equal((await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Membro", password: "senha-segura-123" })).status, 201);
  return c;
}

/** Organização SEM nenhuma integração, com N contratos vigentes. */
async function org(email: string, n = 1) {
  const a = await register(base, email, email);
  const property = (await a.call("POST", "/api/properties", { name: "Prédio", type: "apartamento" })).body.item;
  for (let i = 0; i < n; i++) {
    const unit = (await a.call("POST", "/api/units", { property_id: property.id, identifier: `U${i}` })).body.item;
    const tenant = (await a.call("POST", "/api/tenants", { name: `Inquilino ${i}`, document: `1234567890${i}` })).body.item;
    const lease = (await a.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 150000 + i, due_day: 5 })).body.lease;
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
  }
  return a;
}
const gen = (c: Client, month: string) => c.call("POST", "/api/charges/generate", { month });
const charges = async (c: Client, month: string) => (await c.call("GET", `/api/charges?month=${month}`)).body.items;

describe("boletos manuais (sem integração)", () => {
  it("cria sem Asaas conectado, com saldo e vencimento da cobrança, e barra o segundo", async () => {
    const a = await org("man1@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const r = await a.call("POST", "/api/boletos/manual", {
      charge_id: c.id,
      identification_field: "23793.38128 60000.000003 00000.000400 1 00000000000000",
      our_number: "000123",
      url: "https://banco.exemplo/boleto/123",
      notes: "Emitido no internet banking",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.item.provider, "manual");
    assert.equal(r.body.item.status, "pendente");
    assert.equal(r.body.item.amount_cents, 150000);
    assert.equal(r.body.item.due_date, "2030-06-05");
    assert.equal(r.body.item.our_number, "000123");
    assert.equal(r.body.item.bank_slip_url, "https://banco.exemplo/boleto/123");

    const dup = await a.call("POST", "/api/boletos/manual", { charge_id: c.id });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /já tem um boleto/);
    // O Asaas continua exigindo integração; o manual não.
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: c.id })).status, 409);
  });

  it("valida os campos livres e o valor", async () => {
    const a = await org("man2@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const bad = (extra: Record<string, unknown>) => a.call("POST", "/api/boletos/manual", { charge_id: c.id, ...extra });
    assert.equal((await bad({ identification_field: "abc" })).status, 400);
    assert.equal((await bad({ url: "javascript:alert(1)" })).status, 400);
    assert.equal((await bad({ amount_cents: 150001 })).status, 400, "acima do saldo");
    assert.equal((await bad({ amount_cents: 0 })).status, 400);
    assert.equal((await bad({ due_date: inDays(400) })).status, 400, "mais de 1 ano à frente");
    assert.equal((await bad({ due_date: "2030-02-30" })).status, 400);
    assert.equal((await bad({ notes: "x".repeat(501) })).status, 400);
    const ok = await bad({ amount_cents: 50000, due_date: inDays(20) });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.item.amount_cents, 50000);
    assert.equal(ok.body.item.due_date, inDays(20));
  });

  it("vencimento no passado vira 'vencida' sozinho (sem sincronizar com banco)", async () => {
    const a = await org("man3@x.com");
    await gen(a, PAST);
    const [c] = await charges(a, PAST);
    const r = await a.call("POST", "/api/boletos/manual", { charge_id: c.id });
    assert.equal(r.status, 201);
    assert.equal(r.body.item.status, "vencida");
    assert.equal(r.body.item.due_date, "2024-03-05");
  });

  it("editar, marcar como pago, cancelar e reemitir", async () => {
    const a = await org("man4@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const id = (await a.call("POST", "/api/boletos/manual", { charge_id: c.id })).body.item.id;

    const edit = await a.call("PATCH", `/api/boletos/${id}`, { our_number: "999", notes: "Segunda via" });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.item.our_number, "999");
    assert.equal((await a.call("PATCH", `/api/boletos/${id}`, { url: "ftp://x" })).status, 400);

    assert.equal((await a.call("POST", `/api/boletos/${id}/sync`)).status, 409, "manual não sincroniza");
    assert.equal((await a.call("POST", `/api/boletos/${id}/paid`, { paid_at: "2999-01-01" })).status, 400, "pagamento no futuro");
    const paid = await a.call("POST", `/api/boletos/${id}/paid`, { paid_at: "2030-06-04" });
    // 2030-06-04 está no futuro em relação a hoje: o servidor deve recusar.
    assert.equal(paid.status, 400);
    const paidToday = await a.call("POST", `/api/boletos/${id}/paid`, {});
    assert.equal(paidToday.status, 200);
    assert.equal(paidToday.body.item.status, "paga");
    assert.ok(paidToday.body.item.paid_at);
    assert.equal((await a.call("POST", `/api/boletos/${id}/paid`, {})).status, 409);
    assert.equal((await a.call("PATCH", `/api/boletos/${id}`, { notes: "x" })).status, 409, "pago não edita");
    assert.equal((await a.call("POST", `/api/boletos/${id}/cancel`)).status, 409, "pago não cancela");
    // O boleto pago NÃO baixa a cobrança.
    assert.notEqual((await charges(a, FUTURE))[0].status, "paga");

    // Cancelar e reemitir outro.
    const c2 = (await charges(a, FUTURE))[0];
    const second = await a.call("POST", "/api/boletos/manual", { charge_id: c2.id });
    assert.equal(second.status, 201, "boleto pago não ocupa a vaga de 'em aberto'");
    assert.equal((await a.call("POST", `/api/boletos/${second.body.item.id}/cancel`)).status, 204);
    assert.equal((await a.call("POST", `/api/boletos/${second.body.item.id}/cancel`)).status, 409);
    assert.equal((await a.call("POST", "/api/boletos/manual", { charge_id: c2.id })).status, 201);
  });

  it("em lote: uma guia por cobrança em aberto do mês, sem duplicar; respeita a lista de cobranças", async () => {
    const a = await org("man5@x.com", 3);
    await gen(a, FUTURE);
    const list = await charges(a, FUTURE);
    assert.equal(list.length, 3);
    const first = await a.call("POST", "/api/boletos/manual/bulk", { charge_ids: [list[0].id] });
    assert.equal(first.body.created, 1);
    const all = await a.call("POST", "/api/boletos/manual/bulk", { month: FUTURE });
    assert.equal(all.status, 200);
    assert.equal(all.body.eligible, 2, "a que já tem boleto não entra");
    assert.equal(all.body.created, 2);
    assert.equal(all.body.failed.length, 0);
    assert.equal((await a.call("POST", "/api/boletos/manual/bulk", { month: FUTURE })).body.eligible, 0);
    assert.equal((await a.call("POST", "/api/boletos/manual/bulk", {})).status, 400);
    const open = (await a.call("GET", "/api/boletos?status=pendente")).body.items;
    assert.equal(open.filter((b: { provider: string }) => b.provider === "manual").length, 3);
  });

  it("permissões e isolamento: colaborador emite; só admin cancela; inquilino e outra organização não", async () => {
    const a = await org("man6@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const staff = await memberClient(a, "man6c@x.com", "colaborador");
    const r = await staff.call("POST", "/api/boletos/manual", { charge_id: c.id });
    assert.equal(r.status, 201);
    assert.equal((await staff.call("POST", `/api/boletos/${r.body.item.id}/cancel`)).status, 403);
    assert.equal((await a.call("POST", `/api/boletos/${r.body.item.id}/cancel`)).status, 204);

    const other = await org("man6o@x.com");
    assert.equal((await other.call("POST", "/api/boletos/manual", { charge_id: c.id })).status, 404, "cobrança de outra organização");
    assert.equal((await other.call("PATCH", `/api/boletos/${r.body.item.id}`, { notes: "x" })).status, 404);
    assert.equal((await other.call("POST", `/api/boletos/${r.body.item.id}/paid`)).status, 404);

    const anon = new Client(base);
    assert.equal((await anon.call("POST", "/api/boletos/manual", { charge_id: c.id })).status, 401);
  });
});
