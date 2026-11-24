import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

interface World {
  c: Client;
  orgId: number;
  ownerIds: number[];
  propertyId: number;
  unitId: number;
  tenantId: number;
  leaseId: number;
}

/** Org com proprietário(s), imóvel, unidade, inquilino e contrato VIGENTE. */
async function world(tag: string, opts: { rent?: number; owners?: number; start?: string; end?: string; tenantName?: string; tenantEmail?: string } = {}): Promise<World> {
  const c = await register(base, `f2${tag}@x.com`, `F2 ${tag}`);
  const { rent = 150000, owners = 1, start = "2024-01-01", end = "2030-12-31" } = opts;
  const ownerIds: number[] = [];
  for (let i = 0; i < owners; i++) ownerIds.push((await c.call("POST", "/api/owners", { name: `Dono ${tag}-${i}`, document: `9${tag}${i}` })).body.item.id);
  const property = (await c.call("POST", "/api/properties", { name: `Prédio ${tag}`, type: "apartamento" })).body.item;
  await c.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds });
  const unit = (await c.call("POST", "/api/units", { property_id: property.id, identifier: `U${tag}`, area_m2: 50 })).body.item;
  const tenant = (await c.call("POST", "/api/tenants", { name: opts.tenantName ?? `Inquilino ${tag}`, document: `8${tag}`, email: opts.tenantEmail })).body.item;
  const lease = (await c.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: start, end_date: end, rent_cents: rent, due_day: 5 })).body.lease;
  assert.equal((await c.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
  const orgId = (await c.call("GET", "/api/auth/me")).body.organization.id;
  return { c, orgId, ownerIds, propertyId: property.id, unitId: unit.id, tenantId: tenant.id, leaseId: lease.id };
}
const gen = (c: Client, month: string) => c.call("POST", "/api/charges/generate", { month });
const charges = async (c: Client, month: string) => (await c.call("GET", `/api/charges?month=${month}`)).body.items as { id: number; amount_cents: number; description: string; status: string; kind: string }[];
const pay = (c: Client, leaseId: number, chargeId: number, amount: number, received = "2024-03-10") =>
  c.call("POST", "/api/payments", { lease_id: leaseId, received_at: received, amount_cents: amount, method: "pix", allocations: [{ charge_id: chargeId, amount_cents: amount }] });

describe("configurações financeiras", () => {
  it("lê e altera multa, juros, carência e pro rata (só admin, com validação)", async () => {
    const w = await world("11");
    const def = (await w.c.call("GET", "/api/settings/finance")).body;
    assert.deepEqual(def, { admin_fee_bps: 0, late_fee_bps: 0, late_interest_bps: 0, late_grace_days: 0, prorata_enabled: false });
    const put = (b: Record<string, unknown>) => w.c.call("PUT", "/api/settings/finance", b);
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ late_fee_bps: 1001 })).status, 400);
    assert.equal((await put({ late_grace_days: 31 })).status, 400);
    assert.equal((await put({ prorata_enabled: "sim" })).status, 400);
    const ok = await put({ late_fee_bps: 200, late_interest_bps: 100, late_grace_days: 3, prorata_enabled: true });
    assert.deepEqual(ok.body, { admin_fee_bps: 0, late_fee_bps: 200, late_interest_bps: 100, late_grace_days: 3, prorata_enabled: true });
    assert.equal((await put({ admin_fee_bps: 1000 })).body.late_fee_bps, 200, "campos omitidos ficam como estão");
  });
});

describe("multa e juros automáticos", () => {
  it("cria multa única e juros por bloco de 30 dias, sem repetir, respeitando carência e dry-run", async () => {
    const { applyLateFees } = await import("../src/lateFees.js");
    const w = await world("12", { rent: 100000 });
    await gen(w.c, "2024-03"); // vence 05/03/2024
    const [rent] = await charges(w.c, "2024-03");
    assert.equal((await w.c.call("PUT", "/api/settings/finance", { late_fee_bps: 200, late_interest_bps: 100, late_grace_days: 5 })).status, 200);

    assert.deepEqual(await applyLateFees(w.orgId, { today: "2024-03-08" }), { fees: 0, interests: 0, amountCents: 0 }, "dentro da carência");
    const dry = await applyLateFees(w.orgId, { today: "2024-05-20", dryRun: true });
    assert.deepEqual(dry, { fees: 1, interests: 2, amountCents: 2000 + 1000 + 1000 }, "76 dias: multa de 2% e dois blocos de 1%");
    const { db } = await import("../src/db.js");
    const kids = async () => (await db.query<{ kind: string; amount_cents: number; description: string }>("SELECT kind, amount_cents, description FROM charges WHERE parent_charge_id = $1 AND cancelled_at IS NULL ORDER BY id", [rent!.id]));
    assert.equal((await kids()).length, 0, "dry-run não grava");

    const r = await applyLateFees(w.orgId, { today: "2024-05-20" });
    assert.deepEqual(r, dry);
    const all = await kids();
    assert.equal(all.length, 3);
    const multa = all.find((x) => x.kind === "multa")!;
    assert.equal(multa.amount_cents, 2000);
    assert.match(multa.description, /Multa por atraso \(2%\)/);
    assert.equal(all.filter((x) => x.kind === "juros").length, 2);
    assert.deepEqual(await applyLateFees(w.orgId, { today: "2024-05-20" }), { fees: 0, interests: 0, amountCents: 0 }, "idempotente");

    // Mais 30 dias: só entra o 3º bloco; multa e juros não geram multa/juros em cima deles.
    assert.equal((await applyLateFees(w.orgId, { today: "2024-06-20" })).interests, 1);
    assert.equal((await kids()).length, 4);

    // Cobrança paga não gera encargos.
    await gen(w.c, "2024-04");
    const [apr] = await charges(w.c, "2024-04");
    assert.equal((await pay(w.c, w.leaseId, apr!.id, 100000, "2024-04-05")).status, 201);
    await applyLateFees(w.orgId, { today: "2024-08-01" });
    assert.equal((await db.query("SELECT 1 FROM charges WHERE parent_charge_id = $1", [apr!.id])).length, 0, "paga: sem encargos");
    assert.ok(rent);
  });

  it("a rota é só do admin e devolve o resumo; configuração zerada não faz nada", async () => {
    const w = await world("13");
    await gen(w.c, "2024-03");
    assert.deepEqual((await w.c.call("POST", "/api/charges/late-fees/run", {})).body, { fees: 0, interests: 0, amountCents: 0 }, "multa e juros desligados");
    await w.c.call("PUT", "/api/settings/finance", { late_fee_bps: 100 });
    const r = await w.c.call("POST", "/api/charges/late-fees/run", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.fees, 1);
    assert.equal((await new Client(base).call("POST", "/api/charges/late-fees/run", {})).status, 401);
  });
});

describe("pro rata", () => {
  it("proporcional no primeiro e no último mês, só quando ligado", async () => {
    const off = await world("14", { rent: 310000, start: "2027-03-11", end: "2027-05-20" });
    await gen(off.c, "2027-03");
    assert.equal((await charges(off.c, "2027-03"))[0]!.amount_cents, 310000, "desligado: mês cheio");

    const w = await world("15", { rent: 310000, start: "2027-03-11", end: "2027-05-20" });
    await w.c.call("PUT", "/api/settings/finance", { prorata_enabled: true });
    for (const m of ["2027-03", "2027-04", "2027-05"]) await gen(w.c, m);
    const first = (await charges(w.c, "2027-03"))[0]!;
    assert.equal(first.amount_cents, 210000, "21 de 31 dias");
    assert.match(first.description, /proporcional: 21\/31 dias/);
    assert.equal((await charges(w.c, "2027-04"))[0]!.amount_cents, 310000, "mês do meio é cheio");
    const last = (await charges(w.c, "2027-05"))[0]!;
    assert.equal(last.amount_cents, 200000, "20 de 31 dias");
  });
});

describe("boleto: marcar como pago registrando o pagamento; segunda via", () => {
  it("baixa a cobrança com recibo, limitando ao saldo; sem opção só marca o boleto", async () => {
    const w = await world("16", { rent: 120000, tenantEmail: "inq16@mail.com" });
    await gen(w.c, "2027-01");
    await gen(w.c, "2027-02");
    const [a] = await charges(w.c, "2027-01");
    const [b] = await charges(w.c, "2027-02");
    const mk = async (chargeId: number) => (await w.c.call("POST", "/api/boletos/manual", { charge_id: chargeId, our_number: "N" + chargeId, identification_field: "23793.38128 60000.000003" })).body.item;
    const ba = await mk(a!.id);
    const bb = await mk(b!.id);

    const plain = await w.c.call("POST", `/api/boletos/${bb.id}/paid`, {});
    assert.equal(plain.status, 200);
    assert.equal(plain.body.payment, null);
    assert.equal((await charges(w.c, "2027-02"))[0]!.status, "aberta", "sem a opção a cobrança não é baixada");

    const r = await w.c.call("POST", `/api/boletos/${ba.id}/paid`, { register_payment: true, paid_at: "2026-11-20" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.payment.receipt_number >= 1);
    assert.equal((await charges(w.c, "2027-01"))[0]!.status, "paga");
    const pay1 = (await w.c.call("GET", "/api/payments")).body.items[0];
    assert.equal(pay1.amount_cents, 120000);
    assert.equal(pay1.method, "boleto");

  });

  it("reenvia a segunda via: sino do inquilino e e-mail do cadastro de quem não tem acesso", async () => {
    const { memoryMailer } = await import("../src/mailer.js");
    const w = await world("17", { rent: 90000, tenantEmail: "sem-acesso17@mail.com" });
    await gen(w.c, "2027-03");
    const [ch] = await charges(w.c, "2027-03");
    const bol = (await w.c.call("POST", "/api/boletos/manual", { charge_id: ch!.id, identification_field: "11111.22222 33333.444444", our_number: "9988" })).body.item;
    const r = await w.c.call("POST", `/api/boletos/${bol.id}/resend`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.direct_emails, 1);
    const mail = memoryMailer.outbox.find((m) => m.to === "sem-acesso17@mail.com")!;
    assert.match(mail.text, /Linha digitável: 11111\.22222 33333\.444444/);
    assert.match(mail.text, /Nosso número: 9988/);
    assert.match(mail.text, /R\$\s?900,00/);
    for (let i = 0; i < 4; i++) await w.c.call("POST", `/api/boletos/${bol.id}/resend`);
    assert.equal((await w.c.call("POST", `/api/boletos/${bol.id}/resend`)).status, 429);
    await w.c.call("POST", `/api/boletos/${bol.id}/paid`, {});
    assert.equal((await w.c.call("POST", `/api/boletos/${bol.id}/resend`)).status, 409, "boleto pago não reenvia");
  });
});

describe("conciliação bancária", () => {
  const OFX = (lines: { id: string; date: string; amt: string; memo: string }[]) =>
    `OFXHEADER:100\nDATA:OFXSGML\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n` +
    lines.map((l) => `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${l.date}120000[-3:BRT]<TRNAMT>${l.amt}<FITID>${l.id}<MEMO>${l.memo}</STMTTRN>`).join("\n") +
    `\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it("importa OFX sem duplicar, sugere a cobrança e concilia com recibo; débito é ignorado", async () => {
    const w = await world("18", { rent: 150000, tenantName: "Maria Aparecida Souza" });
    await gen(w.c, "2024-03");
    const [rent] = await charges(w.c, "2024-03");
    const content = OFX([
      { id: "F1", date: "20240310", amt: "1500.00", memo: "PIX RECEBIDO MARIA APARECIDA SOUZA" },
      { id: "F2", date: "20240311", amt: "-85.90", memo: "TARIFA" },
      { id: "F3", date: "20240312", amt: "77.77", memo: "DEPOSITO QUALQUER" },
    ]);
    const imp = await w.c.call("POST", "/api/bank/import", { filename: "extrato.ofx", content });
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    assert.deepEqual([imp.body.read, imp.body.added, imp.body.credits], [3, 3, 2]);
    assert.equal((await w.c.call("POST", "/api/bank/import", { filename: "de-novo.ofx", content })).body.added, 0, "mesmo extrato duas vezes: nada duplica");

    const pend = (await w.c.call("GET", "/api/bank/lines")).body;
    assert.equal(pend.pending, 2);
    const line = pend.items.find((l: { amount_cents: number }) => l.amount_cents === 150000);
    const sug = (await w.c.call("GET", `/api/bank/lines/${line.id}/suggestions`)).body.items;
    assert.equal(sug[0].id, rent!.id);
    assert.ok(sug[0].why.includes("valor igual ao saldo") && sug[0].why.includes("nome do pagador"));

    const rec = await w.c.call("POST", `/api/bank/lines/${line.id}/reconcile`, { lease_id: w.leaseId, charge_id: rent!.id });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal((await charges(w.c, "2024-03"))[0]!.status, "paga");
    const payments = (await w.c.call("GET", "/api/payments")).body.items;
    assert.equal(payments[0].received_at.slice(0, 10), "2024-03-10", "data do extrato");
    assert.equal((await w.c.call("POST", `/api/bank/lines/${line.id}/reconcile`, { lease_id: w.leaseId, charge_id: rent!.id })).status, 409, "não concilia duas vezes");

    const rest = (await w.c.call("GET", "/api/bank/lines")).body.items;
    assert.equal(rest.length, 1);
    assert.equal((await w.c.call("POST", `/api/bank/lines/${rest[0].id}/ignore`)).status, 204);
    assert.equal((await w.c.call("GET", "/api/bank/lines?status=ignorada")).body.items.length, 2, "o débito já nasce ignorado");
    assert.equal((await w.c.call("POST", `/api/bank/lines/${rest[0].id}/restore`)).status, 204);
  });

  it("lê CSV pt-BR, recusa arquivos que não reconhece e escolhe o boleto pelo nosso número", async () => {
    const w = await world("19", { rent: 80000, tenantName: "Joao Pedro Lima" });
    await gen(w.c, "2024-03");
    const [ch] = await charges(w.c, "2024-03");
    await w.c.call("POST", "/api/boletos/manual", { charge_id: ch!.id, our_number: "0012345" });
    const csv = 'Data;Histórico;Valor\n10/03/2024;LIQ BOLETO 0012345;"800,00"\n11/03/2024;TARIFA;-12,50\n';
    const imp = await w.c.call("POST", "/api/bank/import", { filename: "extrato.csv", content: csv });
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    assert.equal(imp.body.source, "csv");
    const line = (await w.c.call("GET", "/api/bank/lines")).body.items[0];
    assert.equal(line.amount_cents, 80000);
    const sug = (await w.c.call("GET", `/api/bank/lines/${line.id}/suggestions`)).body.items;
    assert.ok(sug[0].why.includes("nosso número no histórico"));
    assert.equal((await w.c.call("POST", `/api/bank/lines/${line.id}/reconcile`, { lease_id: w.leaseId, charge_id: ch!.id, method: "boleto" })).status, 200);
    const bol = (await w.c.call("GET", "/api/boletos")).body.items[0];
    assert.equal(bol.status, "paga", "o boleto manual também é marcado como pago");

    assert.equal((await w.c.call("POST", "/api/bank/import", { filename: "x", content: "isso nao eh extrato nenhum, so texto solto" })).status, 422);
    assert.equal((await w.c.call("POST", "/api/bank/import", { filename: "x", content: "curto" })).status, 400);
    assert.equal((await new Client(base).call("GET", "/api/bank/lines")).status, 401);
  });

  it("aceita um extrato grande (bem acima do limite padrão de 100 KB)", async () => {
    const w = await world("20");
    const lines = Array.from({ length: 1500 }, (_, i) => ({ id: `B${i}`, date: "20240310", amt: "10.00", memo: `DEPOSITO ${i} ${"x".repeat(40)}` }));
    const imp = await w.c.call("POST", "/api/bank/import", { filename: "grande.ofx", content: OFX(lines) });
    assert.equal(imp.status, 201, JSON.stringify(imp.body));
    assert.equal(imp.body.added, 1500);
  });
});

describe("rateio de despesas", () => {
  it("divide entre as unidades com contrato vigente (igual e por área), cancela e protege pagas", async () => {
    const w = await world("21", { rent: 100000 });
    // Mais duas unidades no mesmo imóvel, com áreas diferentes.
    const t2 = (await w.c.call("POST", "/api/tenants", { name: "Inq 21b", document: "821b" })).body.item;
    const t3 = (await w.c.call("POST", "/api/tenants", { name: "Inq 21c", document: "821c" })).body.item;
    const u2 = (await w.c.call("POST", "/api/units", { property_id: w.propertyId, identifier: "U21b", area_m2: 100 })).body.item;
    const u3 = (await w.c.call("POST", "/api/units", { property_id: w.propertyId, identifier: "U21c" })).body.item;
    for (const [u, t] of [[u2, t2], [u3, t3]] as const) {
      const l = (await w.c.call("POST", "/api/leases", { unit_id: u.id, tenantIds: [t.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
      await w.c.call("POST", `/api/leases/${l.id}/status`, { status: "vigente" });
    }
    const body = { property_id: w.propertyId, month: "2027-04", description: "Conta de água", total_cents: 10000 };
    assert.equal((await w.c.call("POST", "/api/shared-expenses", { ...body, total_cents: 0 })).status, 400);
    assert.equal((await w.c.call("POST", "/api/shared-expenses", { ...body, method: "area" })).status, 422, "U21c sem área");

    const eq = await w.c.call("POST", "/api/shared-expenses", body);
    assert.equal(eq.status, 201, JSON.stringify(eq.body));
    assert.deepEqual(eq.body.shares_cents, [3334, 3333, 3333]);
    const ch = (await charges(w.c, "2027-04")).filter((c) => c.kind === "taxa");
    assert.equal(ch.length, 3);
    assert.match(ch[0]!.description, /Rateio: Conta de água \(04\/2027\)/);

    assert.equal((await w.c.call("PATCH", `/api/units/${u3.id}`, { area_m2: 50 })).status, 200);
    const ar = await w.c.call("POST", "/api/shared-expenses", { ...body, description: "Energia", total_cents: 20001, method: "area" });
    assert.equal(ar.status, 201, JSON.stringify(ar.body));
    assert.equal(ar.body.shares_cents.reduce((s: number, v: number) => s + v, 0), 20001, "a soma é exata");
    assert.deepEqual(ar.body.shares_cents.map((v: number) => Math.round(v / 100)), [50, 100, 50]);

    const detail = (await w.c.call("GET", `/api/shared-expenses/${eq.body.id}`)).body;
    assert.equal(detail.shares.length, 3);
    assert.equal((await w.c.call("GET", "/api/shared-expenses")).body.items.length, 2);

    // Paga uma das cobranças da 1ª despesa: o cancelamento é recusado até estornar.
    const target = ch.find((c) => c.amount_cents === 3334)!;
    const p = await pay(w.c, detail.shares[0].lease_id, target.id, 3334, "2027-04-01");
    assert.equal(p.status, 400, "recebimento futuro é recusado — usa data passada abaixo");
    const ok = await pay(w.c, detail.shares[0].lease_id, target.id, 3334, "2024-03-10");
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await w.c.call("POST", `/api/shared-expenses/${eq.body.id}/cancel`)).status, 409);
    assert.equal((await w.c.call("POST", `/api/shared-expenses/${ar.body.id}/cancel`)).status, 200);
    assert.equal((await w.c.call("POST", `/api/shared-expenses/${ar.body.id}/cancel`)).status, 409, "já cancelado");
    assert.equal((await charges(w.c, "2027-04")).filter((c) => c.description.includes("Energia") && c.status !== "cancelada").length, 0);

    assert.equal((await w.c.call("POST", "/api/shared-expenses", { ...body, property_id: 999999 })).status, 404);
  });
});

describe("repasse com desconto de manutenção", () => {
  it("desconta o custo cobrado do proprietário, em partes iguais, só se couber; pagos não mudam", async () => {
    const { db } = await import("../src/db.js");
    const w = await world("22", { rent: 100000, owners: 2 });
    await gen(w.c, "2024-03");
    const [rent] = await charges(w.c, "2024-03");
    await pay(w.c, w.leaseId, rent!.id, 100000, "2024-03-10");
    await w.c.call("PUT", "/api/settings/finance", { admin_fee_bps: 1000 });

    const mk = async (cost: number, owner: boolean) => {
      const m = { id: (await w.c.call("POST", "/api/maintenance", { unit_id: w.unitId, category: "hidraulica", title: "Vazamento", description: "Cano estourado" })).body.id };
      await db.query("UPDATE maintenance_requests SET status = 'concluida', cost_cents = $2, charge_owner = $3, completed_at = '2024-03-15T12:00:00Z' WHERE id = $1", [m.id, cost, owner]);
      return m.id as number;
    };
    await mk(20000, true);
    await mk(500000, true); // não cabe no líquido: fica para outro mês
    await mk(9999, false); // custo da administradora: não desconta

    const gen1 = await w.c.call("POST", "/api/transfers/generate", { period: "2024-03" });
    assert.equal(gen1.status, 200, JSON.stringify(gen1.body));
    const tr = (await w.c.call("GET", "/api/transfers?period=2024-03")).body.items as { gross_cents: number; fee_cents: number; maintenance_cents: number; net_cents: number }[];
    assert.equal(tr.length, 2);
    // Cada dono: bruto 50.000; taxa 10% = 5.000; manutenção 20.000/2 = 10.000; líquido 35.000.
    for (const t of tr) assert.deepEqual([t.gross_cents, t.fee_cents, t.maintenance_cents, t.net_cents], [50000, 5000, 10000, 35000]);
    assert.equal(tr.reduce((s, t) => s + t.net_cents, 0), 70000);

    // Regerar é estável (não desconta duas vezes).
    await w.c.call("POST", "/api/transfers/generate", { period: "2024-03" });
    const again = (await w.c.call("GET", "/api/transfers?period=2024-03")).body.items;
    assert.deepEqual(again.map((t: { maintenance_cents: number }) => t.maintenance_cents), [10000, 10000]);

    const assigned = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM maintenance_requests WHERE organization_id = $1 AND owner_deduct_period IS NOT NULL", [w.orgId]);
    assert.equal(assigned[0]!.n, 1, "só o que coube foi atribuído ao repasse");

    // Repasse pago não é tocado.
    const first = again[0];
    assert.equal((await w.c.call("POST", `/api/transfers/${first.id}/pay`, {})).status, 204);
    await w.c.call("POST", "/api/transfers/generate", { period: "2024-03" });
    const after = (await w.c.call("GET", "/api/transfers?period=2024-03")).body.items;
    assert.deepEqual(after.map((t: { net_cents: number }) => t.net_cents), [35000, 35000]);
  });

  it("a conclusão do chamado pede o custo para cobrar do proprietário", async () => {
    const w = await world("23");
    const m = { id: (await w.c.call("POST", "/api/maintenance", { unit_id: w.unitId, category: "eletrica", title: "Tomada", description: "Sem energia" })).body.id };
    const { db } = await import("../src/db.js");
    await db.query("UPDATE maintenance_requests SET status = 'em_execucao' WHERE id = $1", [m.id]);
    const no = await w.c.call("POST", `/api/maintenance/${m.id}/status`, { status: "concluida", charge_owner: true });
    assert.equal(no.status, 400);
    const ok = await w.c.call("POST", `/api/maintenance/${m.id}/status`, { status: "concluida", cost_cents: 15000, charge_owner: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [row] = await db.query<{ charge_owner: boolean }>("SELECT charge_owner FROM maintenance_requests WHERE id = $1", [m.id]);
    assert.equal(row!.charge_owner, true);
  });
});

describe("relatórios", () => {
  it("inadimplência, DRE, fluxo de caixa, informe, DIMOB e KPIs, com CSV seguro e permissões", async () => {
    const w = await world("24", { rent: 100000 });
    await gen(w.c, "2024-03");
    await gen(w.c, "2024-04");
    const [m3] = await charges(w.c, "2024-03");
    await pay(w.c, w.leaseId, m3!.id, 100000, "2024-03-10");
    await w.c.call("PUT", "/api/settings/finance", { admin_fee_bps: 1000 });
    await w.c.call("POST", "/api/transfers/generate", { period: "2024-03" });

    const del = (await w.c.call("GET", "/api/reports/delinquency")).body;
    assert.equal(del.count, 1, "só a de abril está vencida");
    assert.equal(del.total_cents, 100000);
    assert.equal(del.aging_cents["90+"], 100000);
    assert.equal(del.by_tenant[0].tenant, "Inquilino 24");

    const dre = (await w.c.call("GET", "/api/reports/dre?from=2024-03&to=2024-04")).body;
    assert.equal(dre.totals.rent_cents, 100000);
    assert.equal(dre.totals.admin_fee_cents, 10000);
    assert.equal(dre.totals.owner_net_cents, 90000);
    assert.equal(dre.items.length, 1);
    assert.equal((await w.c.call("GET", "/api/reports/dre?from=2024-04&to=2024-03")).status, 400);
    assert.equal((await w.c.call("GET", "/api/reports/dre?from=2020-01&to=2024-12")).status, 400, "mais de 36 meses");

    const cash = (await w.c.call("GET", "/api/reports/cashflow?from=2024-03&to=2024-04")).body.items;
    assert.deepEqual([cash[0].received_cents, cash[0].expected_cents, cash[1].still_open_cents], [100000, 100000, 100000]);

    const informe = (await w.c.call("GET", `/api/reports/owner-income?year=2024&owner_id=${w.ownerIds[0]}`)).body;
    assert.deepEqual([informe.totals.gross_cents, informe.totals.fee_cents, informe.totals.net_cents], [100000, 10000, 90000]);
    assert.equal((await w.c.call("GET", "/api/reports/owner-income?year=2024&owner_id=99999")).status, 404);

    const dimob = (await w.c.call("GET", "/api/reports/dimob?year=2024")).body;
    assert.equal(dimob.items[0].monthly_cents[2], 100000);
    assert.equal(dimob.items[0].total_cents, 100000);

    const kpis = (await w.c.call("GET", "/api/reports/kpis?months=6")).body;
    assert.equal(kpis.items.length, 6);
    assert.equal(kpis.units_total, 1);
    assert.equal(kpis.overdue_cents, 100000);

    // CSV: cabeçalho, BOM, vírgula decimal e proteção contra fórmulas.
    await w.c.call("PATCH", `/api/tenants/${w.tenantId}`, { name: "=HYPERLINK(\"http://x\")", document: `8${24}` });
    const csv = await fetch(`${base}/api/reports/delinquency?format=csv`, { headers: { Cookie: w.c.cookie } });
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM para o Excel abrir em UTF-8");
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    assert.ok(text.startsWith("Locatário;Imóvel"));
    assert.match(text, /1000,00/);
    assert.ok(!/^=HYPERLINK/m.test(text) && text.includes("'=HYPERLINK"), "fórmulas são neutralizadas");

    assert.equal((await new Client(base).call("GET", "/api/reports/kpis")).status, 401);
    const inq = await w.c.call("POST", "/api/invitations", { email: "inq24@x.com", role: "inquilino", tenantId: w.tenantId });
    const ic = new Client(base);
    await ic.call("POST", `/api/invitations/by-token/${new URL(inq.body.link).searchParams.get("invite")}/accept`, { name: "Inq", password: "senha-segura-123" });
    assert.equal((await ic.call("GET", "/api/reports/kpis")).status, 403, "cliente não vê relatórios");
  });

  it("proprietário vê o próprio informe e inquilino vê os boletos abertos para segunda via", async () => {
    const w = await world("25", { rent: 100000 });
    await gen(w.c, "2024-03");
    const [m3] = await charges(w.c, "2024-03");
    await pay(w.c, w.leaseId, m3!.id, 100000, "2024-03-10");
    await w.c.call("POST", "/api/transfers/generate", { period: "2024-03" });
    const inv = await w.c.call("POST", "/api/invitations", { email: "dono25@x.com", role: "proprietario", ownerId: w.ownerIds[0] });
    const oc = new Client(base);
    await oc.call("POST", `/api/invitations/by-token/${new URL(inv.body.link).searchParams.get("invite")}/accept`, { name: "Dono", password: "senha-segura-123" });
    const inc = (await oc.call("GET", "/api/portal/owner/income?year=2024")).body;
    assert.equal(inc.totals.gross_cents, 100000);
    assert.equal((await w.c.call("GET", "/api/portal/owner/income")).status, 403);

    await gen(w.c, "2027-05");
    const [ch] = await charges(w.c, "2027-05");
    await w.c.call("POST", "/api/boletos/manual", { charge_id: ch!.id, identification_field: "00000.11111 22222.333333", our_number: "777" });
    const inv2 = await w.c.call("POST", "/api/invitations", { email: "inq25@x.com", role: "inquilino", tenantId: w.tenantId });
    const tc = new Client(base);
    await tc.call("POST", `/api/invitations/by-token/${new URL(inv2.body.link).searchParams.get("invite")}/accept`, { name: "Inq", password: "senha-segura-123" });
    const list = (await tc.call("GET", "/api/portal/tenant/boletos")).body.items;
    assert.equal(list.length, 1);
    assert.match(list[0].text, /Linha digitável: 00000\.11111/);
    assert.equal((await oc.call("GET", "/api/portal/tenant/boletos")).status, 403);
  });
});
