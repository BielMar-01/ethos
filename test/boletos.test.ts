import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";
import { setAsaasFetch } from "../src/boletos.js";

let base: string;
let close: () => Promise<void>;

interface Call { method: string; path: string; body: Record<string, unknown> | null; token: string }
const calls: Call[] = [];
/** Resposta do Asaas simulada; cada teste ajusta o que precisa. */
const fake = {
  failPayments: 0 as number, // status HTTP a devolver em POST /payments (0 = sucesso)
  statusOf: new Map<string, string>(),
  seq: 0,
};

before(async () => {
  process.env.INTEGRATIONS_SECRET = "segredo-de-teste-com-mais-de-32-caracteres";
  ({ base, close } = await startServer());
  setAsaasFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v3/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body, token: String((init?.headers as Record<string, string>).access_token) });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (method === "POST" && path === "/customers") return json({ id: `cus_${++fake.seq}` });
    if (method === "POST" && path === "/payments") {
      if (fake.failPayments) return json({ errors: [{ description: "Falha simulada" }] }, fake.failPayments);
      const id = `pay_${++fake.seq}`;
      fake.statusOf.set(id, "PENDING");
      return json({ id, status: "PENDING", invoiceUrl: `https://sandbox.asaas.com/i/${id}`, bankSlipUrl: `https://sandbox.asaas.com/b/${id}` });
    }
    const ident = /^\/payments\/(pay_\d+)\/identificationField$/.exec(path);
    if (ident) return json({ identificationField: "23793.38128 60000.000003 00000.000400 1 00000000000000", barCode: "23791000000000000003812860000000000000000400" });
    const one = /^\/payments\/(pay_\d+)$/.exec(path);
    if (one && method === "GET") return json({ id: one[1], status: fake.statusOf.get(one[1]!) ?? "PENDING", paymentDate: "2030-06-02" });
    if (one && method === "DELETE") {
      if (fake.statusOf.get(one[1]!) === "RECEIVED") return json({ errors: [{ description: "Não é possível excluir uma cobrança já recebida" }] }, 400);
      fake.statusOf.set(one[1]!, "DELETED");
      return json({ deleted: true });
    }
    return json({ errors: [{ description: "rota desconhecida" }] }, 404);
  }) as typeof fetch);
});
after(async () => {
  setAsaasFetch(null);
  await close();
});

const KEY = "$aact_hmlg_000000000000000000000000000000000wxyz";
const PAST = "2024-03";
const FUTURE = "2030-06";

async function memberClient(admin: Client, email: string, role: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const inv = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  assert.equal((await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Membro", password: "senha-segura-123" })).status, 201);
  return c;
}

/** Organização com Asaas conectado e N contratos vigentes (documentos de CPF com 11 dígitos). */
async function org(email: string, n = 1, doc = (i: number) => `1234567890${i}`) {
  const a = await register(base, email, email);
  assert.equal((await a.call("PUT", "/api/integrations/asaas", { api_key: KEY, environment: "sandbox", fine_percent: 2, interest_percent: 1 })).status, 200);
  const property = (await a.call("POST", "/api/properties", { name: "Prédio", type: "apartamento" })).body.item;
  const leases: { leaseId: number; tenantId: number }[] = [];
  for (let i = 0; i < n; i++) {
    const unit = (await a.call("POST", "/api/units", { property_id: property.id, identifier: `U${i}` })).body.item;
    const tenant = (await a.call("POST", "/api/tenants", { name: `Inquilino ${i}`, document: doc(i), email: `inq${i}@x.com` })).body.item;
    const lease = (await a.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 150000 + i, due_day: 5 })).body.lease;
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
    leases.push({ leaseId: lease.id, tenantId: tenant.id });
  }
  return { a, leases };
}
const charges = async (c: Client, month: string) => (await c.call("GET", `/api/charges?month=${month}`)).body.items;
const gen = (c: Client, month: string) => c.call("POST", "/api/charges/generate", { month });

const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("boletos (Asaas)", () => {
  it("sem Asaas conectado: status mostra desconectado e emitir é recusado com instrução", async () => {
    const a = await register(base, "bol0@x.com", "B0");
    assert.equal((await a.call("GET", "/api/boletos/status")).body.connected, false);
    const r = await a.call("POST", "/api/boletos", { charge_id: 1 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Integrações/);
  });

  it("emite um boleto: cria o cliente uma vez, envia valor/vencimento/multa/juros e guarda link e linha digitável", async () => {
    const { a } = await org("bol1@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const before = calls.length;
    const r = await a.call("POST", "/api/boletos", { charge_id: c.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const mine = calls.slice(before);
    assert.deepEqual(mine.map((x) => `${x.method} ${x.path.replace(/pay_\d+/, "pay")}`), ["POST /customers", "POST /payments", "GET /payments/pay/identificationField"]);
    assert.equal(mine[0]!.token, KEY);
    assert.equal(mine[0]!.body!.cpfCnpj, "12345678900");
    const pay = mine[1]!.body!;
    assert.equal(pay.billingType, "BOLETO");
    assert.equal(pay.value, 1500);
    assert.equal(pay.dueDate, "2030-06-05");
    assert.deepEqual(pay.fine, { value: 2 });
    assert.deepEqual(pay.interest, { value: 1 });
    assert.equal(pay.externalReference, `ethos-charge-${c.id}`);
    assert.equal(r.body.item.status, "pendente");
    assert.match(r.body.item.invoice_url, /^https:\/\/sandbox\.asaas\.com\/i\/pay_/);
    assert.match(r.body.item.identification_field, /^23793/);

    // Segundo clique: já existe boleto em aberto.
    const dup = await a.call("POST", "/api/boletos", { charge_id: c.id });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /já tem um boleto/);
    assert.equal((await a.call("GET", `/api/boletos?charge_id=${c.id}`)).body.items.length, 1);
  });

  it("cobrança vencida usa hoje como vencimento; vencimento escolhido é validado; reaproveita o cliente do Asaas", async () => {
    const { a } = await org("bol2@x.com");
    await gen(a, PAST);
    await gen(a, FUTURE);
    const [old] = await charges(a, PAST);
    const [fut] = await charges(a, FUTURE);
    calls.length = 0;
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: old.id })).status, 201);
    assert.equal(calls.find((x) => x.path === "/payments" && x.method === "POST")!.body!.dueDate, today);
    // Segundo boleto do mesmo inquilino: não cria cliente de novo.
    calls.length = 0;
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: fut.id, due_date: inDays(30) })).status, 201);
    assert.ok(!calls.some((x) => x.path === "/customers"), "reaproveita o cliente");
    assert.equal(calls.find((x) => x.path === "/payments" && x.method === "POST")!.body!.dueDate, inDays(30));
    // Datas inválidas.
    const [other] = await charges(a, FUTURE);
    void other;
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: fut.id, due_date: "2020-01-01" })).status, 400);
  });

  it("recusa vencimento no passado ou além de 1 ano, cobrança paga, cancelada e CPF/CNPJ inválido", async () => {
    const { a } = await org("bol3@x.com", 1, () => "123");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const bad = await a.call("POST", "/api/boletos", { charge_id: c.id });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error, /CPF\/CNPJ/);
    assert.equal((await a.call("GET", "/api/boletos")).body.items.length, 0, "a vaga é liberada");

    const ok = await org("bol3b@x.com");
    await gen(ok.a, FUTURE);
    const [d] = await charges(ok.a, FUTURE);
    assert.equal((await ok.a.call("POST", "/api/boletos", { charge_id: d.id, due_date: "2020-01-01" })).status, 400);
    assert.equal((await ok.a.call("POST", "/api/boletos", { charge_id: d.id, due_date: "2099-01-01" })).status, 400);
    assert.equal((await ok.a.call("POST", "/api/boletos", { charge_id: d.id, due_date: "2030-02-31" })).status, 400);
    assert.equal((await ok.a.call("POST", "/api/boletos", { charge_id: 99999 })).status, 404);
    assert.equal((await ok.a.call("POST", "/api/boletos", {})).status, 400);
    assert.equal((await ok.a.call("POST", `/api/charges/${d.id}/cancel`)).status, 204);
    assert.equal((await ok.a.call("POST", "/api/boletos", { charge_id: d.id })).status, 409);
  });

  it("falha no Asaas não deixa boleto pela metade e permite tentar de novo", async () => {
    const { a } = await org("bol4@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    fake.failPayments = 400;
    const r = await a.call("POST", "/api/boletos", { charge_id: c.id });
    fake.failPayments = 0;
    assert.equal(r.status, 422);
    assert.match(r.body.error, /Falha simulada/);
    assert.equal((await a.call("GET", "/api/boletos")).body.items.length, 0);
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: c.id })).status, 201);
  });

  it("em lote: emite todas as cobranças abertas do mês, pula as que já têm boleto e relata falhas", async () => {
    const { a } = await org("bol5@x.com", 4);
    await gen(a, FUTURE);
    const list = await charges(a, FUTURE);
    assert.equal(list.length, 4);
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: list[0].id })).status, 201);
    const r = await a.call("POST", "/api/boletos/bulk", { month: FUTURE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.eligible, 3);
    assert.equal(r.body.created, 3);
    assert.deepEqual(r.body.failed, []);
    assert.equal(r.body.remaining, 0);
    assert.equal((await a.call("GET", `/api/boletos?month=${FUTURE}`)).body.items.length, 4);
    // Nada mais a emitir.
    assert.equal((await a.call("POST", "/api/boletos/bulk", { month: FUTURE })).body.eligible, 0);
    assert.equal((await a.call("POST", "/api/boletos/bulk", {})).status, 400);
    assert.equal((await a.call("POST", "/api/boletos/bulk", { month: "2030-13" })).status, 400);
  });

  it("em lote por ids, com chave recusada: para na primeira falha geral e informa quantas faltam", async () => {
    const { a } = await org("bol6@x.com", 3);
    await gen(a, FUTURE);
    const ids = (await charges(a, FUTURE)).map((c: { id: number }) => c.id);
    fake.failPayments = 401;
    const r = await a.call("POST", "/api/boletos/bulk", { charge_ids: ids });
    fake.failPayments = 0;
    assert.equal(r.status, 200);
    assert.equal(r.body.created, 0);
    assert.equal(r.body.failed.length, 1, "parou na primeira");
    assert.match(r.body.stopped_by, /recusou a chave/);
    assert.equal(r.body.remaining, 2);
    assert.equal((await a.call("GET", "/api/boletos")).body.items.length, 0);
  });

  it("sincroniza: boleto pago no Asaas vira 'paga'; cancelar boleto pago é recusado; cancelar pendente libera nova emissão", async () => {
    const { a } = await org("bol7@x.com", 2);
    await gen(a, FUTURE);
    const [c1, c2] = await charges(a, FUTURE);
    const b1 = (await a.call("POST", "/api/boletos", { charge_id: c1.id })).body.item;
    const b2 = (await a.call("POST", "/api/boletos", { charge_id: c2.id })).body.item;
    const id1 = calls.filter((x) => x.method === "POST" && x.path === "/payments").length; // só para garantir que houve chamadas
    assert.ok(id1 > 0);
    const ext1 = [...fake.statusOf.keys()].at(-2)!;
    fake.statusOf.set(ext1, "RECEIVED");

    const one = await a.call("POST", `/api/boletos/${b1.id}/sync`);
    assert.equal(one.status, 200);
    assert.equal(one.body.item.status, "paga");
    assert.equal(one.body.item.paid_at, "2030-06-02");
    assert.equal((await a.call("POST", `/api/boletos/${b1.id}/cancel`)).status, 409);

    const all = await a.call("POST", "/api/boletos/sync");
    assert.equal(all.status, 200);
    assert.equal(all.body.paid, 0, "o b1 já estava paga; o b2 continua pendente");

    assert.equal((await a.call("POST", `/api/boletos/${b2.id}/cancel`)).status, 204);
    assert.equal((await a.call("GET", `/api/boletos?status=cancelada`)).body.items.length, 1);
    assert.equal((await a.call("POST", "/api/boletos", { charge_id: c2.id })).status, 201, "pode emitir outro");
    assert.equal((await a.call("POST", `/api/boletos/${b2.id}/cancel`)).status, 409, "já cancelado");
  });

  it("papéis e isolamento: colaborador emite mas não cancela; inquilino não acessa; outra organização não vê nada", async () => {
    const { a, leases } = await org("bol8@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    const col = await memberClient(a, "bol8col@x.com", "colaborador");
    const created = await col.call("POST", "/api/boletos", { charge_id: c.id });
    assert.equal(created.status, 201);
    assert.equal((await col.call("POST", `/api/boletos/${created.body.item.id}/cancel`)).status, 403);
    const tenantUser = await memberClient(a, "bol8t@x.com", "inquilino", { tenantId: leases[0]!.tenantId });
    assert.equal((await tenantUser.call("GET", "/api/boletos")).status, 403);
    assert.equal((await tenantUser.call("POST", "/api/boletos", { charge_id: c.id })).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/boletos")).status, 401);

    const other = await org("bol8o@x.com");
    assert.equal((await other.a.call("GET", "/api/boletos")).body.items.length, 0);
    assert.equal((await other.a.call("POST", "/api/boletos", { charge_id: c.id })).status, 404);
    assert.equal((await other.a.call("POST", `/api/boletos/${created.body.item.id}/sync`)).status, 404);
    assert.equal((await other.a.call("POST", `/api/boletos/${created.body.item.id}/cancel`)).status, 404);
  });

  it("registra a emissão na auditoria e valida os percentuais de multa/juros", async () => {
    const { a } = await org("bol9@x.com");
    await gen(a, FUTURE);
    const [c] = await charges(a, FUTURE);
    await a.call("POST", "/api/boletos", { charge_id: c.id });
    const audit = (await a.call("GET", "/api/audit?q=boleto")).body.items;
    assert.ok(audit.some((e: { summary: string }) => /Emitiu boleto/.test(e.summary)));
    assert.equal((await a.call("PUT", "/api/integrations/asaas", { fine_percent: 50 })).status, 400);
    assert.equal((await a.call("PUT", "/api/integrations/asaas", { interest_percent: -1 })).status, 400);
    assert.equal((await a.call("PUT", "/api/integrations/asaas", { fine_percent: 0, interest_percent: "" })).status, 200);
    const st = (await a.call("GET", "/api/boletos/status")).body;
    assert.equal(st.connected, true);
    assert.equal(st.fine_percent, 0);
  });
});
