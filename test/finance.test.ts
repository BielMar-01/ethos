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

// Meses passados (2024) são "vencidos" e futuros (2030) "abertos", qualquer que seja a data de hoje.
const PAST = "2024-03";
const FUTURE = "2030-06";

interface Fin {
  ownerIds: number[];
  propertyId: number;
  unitId: number;
  tenantId: number;
  leaseId: number;
}

/** Proprietário(s), imóvel, unidade, inquilino e contrato VIGENTE de 2024 a 2030. */
async function setup(
  c: Client,
  tag: string,
  opts: { rent?: number; dueDay?: number; owners?: number; activate?: boolean } = {},
): Promise<Fin> {
  const { rent = 150000, dueDay = 5, owners = 1, activate = true } = opts;
  const ownerIds: number[] = [];
  for (let i = 0; i < owners; i++) {
    ownerIds.push((await c.call("POST", "/api/owners", { name: `Dono ${tag}-${i}`, document: `9${tag}${i}` })).body.item.id);
  }
  const property = (await c.call("POST", "/api/properties", { name: `Prédio ${tag}`, type: "apartamento" })).body.item;
  if (owners > 0) assert.equal((await c.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds })).status, 200);
  const unit = (await c.call("POST", "/api/units", { property_id: property.id, identifier: `U${tag}` })).body.item;
  const tenant = (await c.call("POST", "/api/tenants", { name: `Inquilino ${tag}`, document: `8${tag}` })).body.item;
  const lease = (
    await c.call("POST", "/api/leases", {
      unit_id: unit.id,
      tenantIds: [tenant.id],
      start_date: "2024-01-01",
      end_date: "2030-12-31",
      rent_cents: rent,
      due_day: dueDay,
    })
  ).body.lease;
  if (activate) assert.equal((await c.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
  return { ownerIds, propertyId: property.id, unitId: unit.id, tenantId: tenant.id, leaseId: lease.id };
}

const generate = (c: Client, month: string) => c.call("POST", "/api/charges/generate", { month });
const charges = async (c: Client, month: string) => (await c.call("GET", `/api/charges?month=${month}`)).body.items;
const pay = (c: Client, leaseId: number, allocations: { charge_id: number; amount_cents: number }[], extra: Record<string, unknown> = {}) =>
  c.call("POST", "/api/payments", {
    lease_id: leaseId,
    received_at: "2024-03-10",
    amount_cents: allocations.reduce((s, a) => s + a.amount_cents, 0),
    method: "pix",
    allocations,
    ...extra,
  });

/** Convida um membro com o papel dado e devolve o cliente logado como ele. */
async function memberClient(admin: Client, email: string, role: string): Promise<Client> {
  const inv = await admin.call("POST", "/api/invitations", { email, role });
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  const r = await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Membro", password: "senha-segura-123" });
  assert.equal(r.status, 201);
  return c;
}

describe("cobranças", () => {
  it("gera o aluguel do mês só para contratos vigentes no período, sem duplicar", async () => {
    const a = await register(base, "f1@x.com", "F1");
    const s = await setup(a, "1");
    await setup(a, "2", { activate: false }); // rascunho: não gera

    const first = await generate(a, PAST);
    assert.deepEqual(first.body, { month: PAST, eligible: 1, created: 1, skipped: 0 });
    const again = await generate(a, PAST);
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skipped, 1);

    const [c] = await charges(a, PAST);
    assert.equal(c.lease_id, s.leaseId);
    assert.equal(c.amount_cents, 150000);
    assert.equal(c.due_date, "2024-03-05");
    assert.equal(c.description, "Aluguel 03/2024");
    assert.equal(c.competence, "2024-03-01");
    assert.equal(c.tenant_names, "Inquilino 1");

    assert.equal((await generate(a, "2031-01")).body.eligible, 0, "fora da vigência");
    assert.equal((await generate(a, "2024-13")).status, 400);
    assert.equal((await generate(a, "marco")).status, 400);
  });

  it("ajusta o vencimento ao último dia de meses curtos", async () => {
    const a = await register(base, "f2@x.com", "F2");
    await setup(a, "3", { dueDay: 31 });
    await generate(a, "2024-02");
    await generate(a, "2024-04");
    assert.equal((await charges(a, "2024-02"))[0].due_date, "2024-02-29", "2024 é bissexto");
    assert.equal((await charges(a, "2024-04"))[0].due_date, "2024-04-30");
  });

  it("deriva o status: vencida no passado, aberta no futuro; filtra por status", async () => {
    const a = await register(base, "f3@x.com", "F3");
    await setup(a, "4");
    await generate(a, PAST);
    await generate(a, FUTURE);
    assert.equal((await charges(a, PAST))[0].status, "vencida");
    assert.equal((await charges(a, FUTURE))[0].status, "aberta");
    assert.equal((await a.call("GET", "/api/charges?status=vencida")).body.items.length, 1);
    assert.equal((await a.call("GET", "/api/charges?status=aberta")).body.items.length, 1);
    assert.equal((await a.call("GET", "/api/charges?status=xyz")).status, 400);
    assert.equal((await a.call("GET", "/api/charges?month=2024-99")).status, 400);
  });

  it("cria cobrança avulsa com validação e recusa contrato em rascunho", async () => {
    const a = await register(base, "f4@x.com", "F4");
    const s = await setup(a, "5");
    const draft = await setup(a, "6", { activate: false });
    const body = { lease_id: s.leaseId, kind: "multa", description: "Multa por atraso", due_date: "2024-04-10", amount_cents: 5000 };

    const ok = await a.call("POST", "/api/charges", body);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.item.competence, "2024-04-01");
    assert.equal((await a.call("POST", "/api/charges", { ...body, kind: "x" })).status, 400);
    assert.equal((await a.call("POST", "/api/charges", { ...body, amount_cents: 0 })).status, 400);
    assert.equal((await a.call("POST", "/api/charges", { ...body, amount_cents: 10.5 })).status, 400);
    assert.equal((await a.call("POST", "/api/charges", { ...body, due_date: "2024-02-31" })).status, 400);
    assert.equal((await a.call("POST", "/api/charges", { ...body, description: " " })).status, 400);
    assert.equal((await a.call("POST", "/api/charges", { ...body, lease_id: draft.leaseId })).status, 409);

    // Aluguel manual duplicado na mesma competência é recusado.
    await generate(a, PAST);
    const dup = await a.call("POST", "/api/charges", { ...body, kind: "aluguel", due_date: "2024-03-20" });
    assert.equal(dup.status, 409);
  });
});

describe("pagamentos e baixas", () => {
  it("baixa parcial e total, com status e recibos numerados", async () => {
    const a = await register(base, "p1@x.com", "P1");
    const s = await setup(a, "7");
    await generate(a, PAST);
    const [charge] = await charges(a, PAST);

    const part = await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 50000 }], { method: "pix", reference: "E2E123" });
    assert.equal(part.status, 201);
    assert.equal(part.body.payment.receipt_number, 1);
    let [c] = await charges(a, PAST);
    assert.equal(c.paid_cents, 50000);
    assert.equal(c.status, "vencida", "parcial e vencida continua vencida");

    const rest = await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 100000 }], { method: "dinheiro" });
    assert.equal(rest.body.payment.receipt_number, 2);
    [c] = await charges(a, PAST);
    assert.equal(c.status, "paga");

    const detail = (await a.call("GET", `/api/payments/${part.body.payment.id}`)).body;
    assert.match(detail.payment.receipt_content, /RECIBO Nº 1/);
    assert.match(detail.payment.receipt_content, /Inquilino 7/);
    assert.match(detail.payment.receipt_content, /R\$ 500,00/);
    assert.match(detail.payment.receipt_content, /E2E123/);
    assert.match(detail.payment.receipt_content, /Aluguel 03\/2024/);
    assert.equal(detail.allocations.length, 1);
    assert.equal((await a.call("GET", `/api/payments?month=${PAST}`)).body.items.length, 2);
  });

  it("parcial em cobrança ainda não vencida fica 'parcial'", async () => {
    const a = await register(base, "p2@x.com", "P2");
    const s = await setup(a, "8");
    await generate(a, FUTURE);
    const [charge] = await charges(a, FUTURE);
    await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 1000 }]);
    assert.equal((await charges(a, FUTURE))[0].status, "parcial");
  });

  it("recusa pagamentos inconsistentes", async () => {
    const a = await register(base, "p3@x.com", "P3");
    const other = await register(base, "p3b@x.com", "P3B");
    const s = await setup(a, "9");
    const o = await setup(other, "10");
    await generate(a, PAST);
    await generate(other, PAST);
    const [charge] = await charges(a, PAST);
    const [foreign] = await charges(other, PAST);
    const ok = { charge_id: charge.id, amount_cents: 1000 };

    // valor excede o saldo
    assert.equal((await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 150001 }])).status, 409);
    // soma das baixas diferente do valor
    assert.equal((await pay(a, s.leaseId, [ok], { amount_cents: 2000 })).status, 400);
    // data futura / inválida
    assert.equal((await pay(a, s.leaseId, [ok], { received_at: "2999-01-01" })).status, 400);
    assert.equal((await pay(a, s.leaseId, [ok], { received_at: "2024-02-31" })).status, 400);
    // forma de pagamento / lista vazia / repetida / valor não positivo
    assert.equal((await pay(a, s.leaseId, [ok], { method: "cheque" })).status, 400);
    assert.equal((await a.call("POST", "/api/payments", { lease_id: s.leaseId, received_at: "2024-03-10", amount_cents: 1, method: "pix", allocations: [] })).status, 400);
    assert.equal((await pay(a, s.leaseId, [ok, ok], { amount_cents: 2000 })).status, 400);
    assert.equal((await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: -5 }], { amount_cents: -5 })).status, 400);
    // cobrança/contrato de outra organização
    assert.equal((await pay(a, s.leaseId, [{ charge_id: foreign.id, amount_cents: 1000 }])).status, 400);
    assert.equal((await pay(a, o.leaseId, [{ charge_id: charge.id, amount_cents: 1000 }])).status, 400);
    // nada foi gravado pelas tentativas inválidas
    assert.equal((await a.call("GET", "/api/payments")).body.items.length, 0);
    assert.equal((await charges(a, PAST))[0].paid_cents, 0);
  });

  it("não baixa cobrança de outro contrato nem cancelada", async () => {
    const a = await register(base, "p4@x.com", "P4");
    const s1 = await setup(a, "11");
    const s2 = await setup(a, "12");
    await generate(a, PAST);
    const all = await charges(a, PAST);
    const c1 = all.find((c: { lease_id: number }) => c.lease_id === s1.leaseId);
    const c2 = all.find((c: { lease_id: number }) => c.lease_id === s2.leaseId);
    assert.equal((await pay(a, s1.leaseId, [{ charge_id: c2.id, amount_cents: 1000 }])).status, 400);
    assert.equal((await a.call("POST", `/api/charges/${c1.id}/cancel`)).status, 204);
    assert.equal((await pay(a, s1.leaseId, [{ charge_id: c1.id, amount_cents: 1000 }])).status, 409);
    assert.equal((await charges(a, PAST)).find((c: { id: number }) => c.id === c1.id).status, "cancelada");
  });

  it("estorno devolve a cobrança a aberto; só admin estorna e cancela", async () => {
    const a = await register(base, "p5@x.com", "P5");
    const col = await memberClient(a, "p5col@x.com", "colaborador");
    const s = await setup(a, "13");
    await generate(a, PAST);
    const [charge] = await charges(a, PAST);
    const payment = (await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 150000 }])).body.payment;
    assert.equal((await charges(a, PAST))[0].status, "paga");

    // Cobrança com pagamento não pode ser cancelada.
    assert.equal((await a.call("POST", `/api/charges/${charge.id}/cancel`)).status, 409);
    assert.equal((await col.call("POST", `/api/payments/${payment.id}/void`, { reason: "erro" })).status, 403);
    assert.equal((await col.call("POST", `/api/charges/${charge.id}/cancel`)).status, 403);
    assert.equal((await a.call("POST", `/api/payments/${payment.id}/void`, {})).status, 400, "motivo obrigatório");

    assert.equal((await a.call("POST", `/api/payments/${payment.id}/void`, { reason: "Pix devolvido" })).status, 204);
    assert.equal((await a.call("POST", `/api/payments/${payment.id}/void`, { reason: "de novo" })).status, 404);
    const [after] = await charges(a, PAST);
    assert.equal(after.paid_cents, 0);
    assert.equal(after.status, "vencida");
    const stored = (await a.call("GET", `/api/payments/${payment.id}`)).body.payment;
    assert.equal(stored.void_reason, "Pix devolvido");
    assert.ok(stored.voided_at);

    // Novo pagamento reaproveita a cobrança e o número do recibo segue a sequência (sem reutilizar).
    const again = await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 150000 }]);
    assert.equal(again.body.payment.receipt_number, 2);
  });

  it("colaborador registra pagamento; papel inquilino não acessa o financeiro", async () => {
    const a = await register(base, "p6@x.com", "P6");
    const col = await memberClient(a, "p6col@x.com", "colaborador");
    const tenantUser = await memberClient(a, "p6inq@x.com", "inquilino");
    const s = await setup(a, "14");
    await generate(a, PAST);
    const [charge] = await charges(col, PAST);
    assert.equal((await pay(col, s.leaseId, [{ charge_id: charge.id, amount_cents: 1000 }])).status, 201);
    for (const path of ["/api/charges", "/api/payments", "/api/transfers", "/api/finance/summary?month=2024-03"]) {
      assert.equal((await tenantUser.call("GET", path)).status, 403, path);
    }
    assert.equal((await new Client(base).call("GET", "/api/charges")).status, 401);
  });
});

describe("isolamento entre organizações", () => {
  it("não vaza cobranças, pagamentos nem repasses", async () => {
    const a = await register(base, "i1@x.com", "I1");
    const b = await register(base, "i2@x.com", "I2");
    const s = await setup(a, "15");
    await generate(a, PAST);
    const [charge] = await charges(a, PAST);
    const payment = (await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 1000 }])).body.payment;
    await a.call("POST", "/api/transfers/generate", { period: PAST });

    assert.equal((await b.call("GET", "/api/charges")).body.items.length, 0);
    assert.equal((await b.call("GET", "/api/payments")).body.items.length, 0);
    assert.equal((await b.call("GET", "/api/transfers")).body.items.length, 0);
    assert.equal((await b.call("GET", `/api/payments/${payment.id}`)).status, 404);
    assert.equal((await b.call("POST", `/api/payments/${payment.id}/void`, { reason: "x" })).status, 404);
    assert.equal((await b.call("POST", `/api/charges/${charge.id}/cancel`)).status, 404);
    assert.equal((await b.call("GET", `/api/charges?lease_id=${s.leaseId}`)).body.items.length, 0);
    const summary = (await b.call("GET", `/api/finance/summary?month=${PAST}`)).body;
    assert.equal(summary.expected_cents, 0);
  });
});

describe("repasses", () => {
  it("divide entre proprietários, aplica a taxa e não recalcula o que já foi pago", async () => {
    const a = await register(base, "r1@x.com", "R1");
    // 1000,01 dividido entre dois proprietários: 500,01 e 500,00; taxa de 10%.
    const s = await setup(a, "16", { rent: 100001, owners: 2 });
    assert.equal((await a.call("PUT", "/api/settings/finance", { admin_fee_bps: 1000 })).status, 200);
    await generate(a, PAST);
    const [charge] = await charges(a, PAST);
    const payment = (await pay(a, s.leaseId, [{ charge_id: charge.id, amount_cents: 100001 }])).body.payment;

    const gen = await a.call("POST", "/api/transfers/generate", { period: PAST });
    assert.equal(gen.body.generated, 2);
    let items = (await a.call("GET", `/api/transfers?period=${PAST}`)).body.items;
    assert.equal(items.length, 2);
    const gross = items.map((t: { gross_cents: number }) => t.gross_cents).sort((x: number, y: number) => y - x);
    assert.deepEqual(gross, [50001, 50000]);
    for (const t of items) {
      assert.equal(t.fee_cents, 5000);
      assert.equal(t.net_cents, t.gross_cents - 5000);
      assert.equal(t.status, "pendente");
      assert.equal(t.fee_bps, 1000);
    }
    assert.equal(items.reduce((sum: number, t: { gross_cents: number }) => sum + t.gross_cents, 0), 100001, "nenhum centavo se perde");

    // Gerar de novo não duplica.
    await a.call("POST", "/api/transfers/generate", { period: PAST });
    assert.equal((await a.call("GET", `/api/transfers?period=${PAST}`)).body.items.length, 2);

    // Paga um repasse; só admin; não paga duas vezes.
    const col = await memberClient(a, "r1col@x.com", "colaborador");
    const first = items[0];
    assert.equal((await col.call("POST", `/api/transfers/${first.id}/pay`, {})).status, 403);
    assert.equal((await a.call("POST", `/api/transfers/${first.id}/pay`, { paid_at: "2999-01-01" })).status, 400);
    assert.equal((await a.call("POST", `/api/transfers/${first.id}/pay`, { paid_at: "2024-04-02" })).status, 204);
    assert.equal((await a.call("POST", `/api/transfers/${first.id}/pay`, {})).status, 404);

    // Estorno do pagamento + nova geração: o repasse pago permanece; o pendente some (sem base).
    await a.call("POST", `/api/payments/${payment.id}/void`, { reason: "teste" });
    const regen = await a.call("POST", "/api/transfers/generate", { period: PAST });
    assert.equal(regen.body.generated, 0);
    assert.equal(regen.body.alreadyPaid, 1);
    items = (await a.call("GET", `/api/transfers?period=${PAST}`)).body.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].status, "pago");
    assert.equal(items[0].paid_at, "2024-04-02");
  });

  it("considera só aluguel recebido no mês e informa o que ficou sem proprietário", async () => {
    const a = await register(base, "r2@x.com", "R2");
    const s = await setup(a, "17", { rent: 80000, owners: 0 });
    await generate(a, PAST);
    const [rent] = await charges(a, PAST);
    const fine = (await a.call("POST", "/api/charges", { lease_id: s.leaseId, kind: "multa", description: "Multa", due_date: "2024-03-20", amount_cents: 2000 })).body.item;
    await pay(a, s.leaseId, [{ charge_id: rent.id, amount_cents: 80000 }, { charge_id: fine.id, amount_cents: 2000 }]);

    const gen = await a.call("POST", "/api/transfers/generate", { period: PAST });
    assert.equal(gen.body.generated, 0);
    assert.equal(gen.body.withoutOwnerCents, 80000, "multa não entra no repasse de aluguel");
    assert.equal((await a.call("POST", "/api/transfers/generate", { period: "2024-3" })).status, 400);
  });

  it("valida a taxa de administração e restringe a admin", async () => {
    const a = await register(base, "r3@x.com", "R3");
    const col = await memberClient(a, "r3col@x.com", "colaborador");
    assert.equal((await a.call("PUT", "/api/settings/finance", { admin_fee_bps: 10001 })).status, 400);
    assert.equal((await a.call("PUT", "/api/settings/finance", { admin_fee_bps: 5.5 })).status, 400);
    assert.equal((await col.call("PUT", "/api/settings/finance", { admin_fee_bps: 500 })).status, 403);
    assert.equal((await col.call("GET", "/api/settings/finance")).body.admin_fee_bps, 0);
  });
});

describe("resumo financeiro", () => {
  it("calcula previsto, recebido e em atraso", async () => {
    const a = await register(base, "s1@x.com", "S1");
    const s = await setup(a, "18", { rent: 150000 });
    await generate(a, PAST);
    await generate(a, "2024-04");
    const [march] = await charges(a, PAST);
    await pay(a, s.leaseId, [{ charge_id: march.id, amount_cents: 50000 }]);

    const sum = (await a.call("GET", `/api/finance/summary?month=${PAST}`)).body;
    assert.equal(sum.expected_cents, 150000);
    assert.equal(sum.received_cents, 50000);
    assert.equal(sum.received_ratio, 33.3);
    assert.equal(sum.cash_received_cents, 50000);
    // Atraso considera todos os meses vencidos: 100.000 de março + 150.000 de abril.
    assert.equal(sum.overdue_cents, 250000);
    assert.equal(sum.overdue_count, 2);
    assert.equal((await a.call("GET", "/api/finance/summary?month=abc")).status, 400);
  });
});
