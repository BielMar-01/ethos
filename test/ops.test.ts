import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function memberClient(admin: Client, email: string, role: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const inv = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  assert.equal((await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Membro " + email, password: "senha-segura-123" })).status, 201);
  return c;
}

async function world(tag: string) {
  const admin = await register(base, `op${tag}@x.com`, `Op ${tag}`);
  const owner = (await admin.call("POST", "/api/owners", { name: "Dono", document: `9${tag}` })).body.item;
  const property = (await admin.call("POST", "/api/properties", { name: "Prédio", type: "apartamento" })).body.item;
  await admin.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: "Apto 1" })).body.item;
  const tenant = (await admin.call("POST", "/api/tenants", { name: "Locatário", document: `8${tag}` })).body.item;
  const lease = (await admin.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
  await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  const tenantClient = await memberClient(admin, `inq-${tag}@x.com`, "inquilino", { tenantId: tenant.id });
  const ownerClient = await memberClient(admin, `dono-${tag}@x.com`, "proprietario", { ownerId: owner.id });
  return { admin, tenantClient, ownerClient, propertyId: property.id as number, unitId: unit.id as number, leaseId: lease.id as number };
}

describe("prestadores", () => {
  it("cadastra com validação, filtra por categoria, avalia e compara orçamentos", async () => {
    const { db } = await import("../src/db.js");
    const w = await world("1");
    assert.equal((await w.admin.call("POST", "/api/providers", { name: "A" })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/providers", { name: "João Eletricista", categories: ["magica"] })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/providers", { name: "João Eletricista", phone: "12" })).status, 400);
    const a = (await w.admin.call("POST", "/api/providers", { name: "João Eletricista", phone: "11999990000", categories: ["eletrica", "fechaduras"], document: "52998224725" })).body.item;
    const b = (await w.admin.call("POST", "/api/providers", { name: "Hidro Master", categories: "hidraulica" })).body.item;
    assert.equal(a.phone, "(11) 99999-0000");
    assert.equal((await w.admin.call("GET", "/api/providers?category=eletrica")).body.items.length, 1);
    assert.equal((await w.admin.call("PATCH", `/api/providers/${b.id}`, { active: false })).body.item.active, false);
    assert.equal((await w.admin.call("GET", "/api/providers")).body.items.length, 1, "inativos saem da lista padrão");
    assert.equal((await w.admin.call("GET", "/api/providers?all=1")).body.items.length, 2);

    // Chamado concluído para avaliar; orçamentos de dois prestadores para comparar.
    const m = (await w.admin.call("POST", "/api/maintenance", { unit_id: w.unitId, category: "eletrica", title: "Curto", description: "Disjuntor cai" })).body.id;
    await w.admin.call("POST", `/api/maintenance/${m}/status`, { status: "em_analise" });
    const q1 = (await w.admin.call("POST", `/api/maintenance/${m}/quotes`, { supplier: "João Eletricista", amount_cents: 45000 })).body.id;
    const q2 = (await w.admin.call("POST", `/api/maintenance/${m}/quotes`, { supplier: "Outro Eletricista", amount_cents: 38000 })).body.id;
    assert.equal((await w.admin.call("POST", `/api/maintenance/${m}/quotes/${q1}/provider`, { provider_id: a.id })).status, 204);
    assert.equal((await w.admin.call("POST", `/api/maintenance/${m}/quotes/${q1}/provider`, { provider_id: 999999 })).status, 400);
    const cmp = (await w.admin.call("GET", `/api/maintenance/${m}/quotes/compare`)).body;
    assert.deepEqual(cmp.items.map((i: { amount_cents: number }) => i.amount_cents), [38000, 45000], "menor valor primeiro");
    assert.equal(cmp.cheapest_cents, 38000);
    assert.equal(cmp.spread_cents, 7000);
    assert.equal(cmp.items[1].provider_name, "João Eletricista");
    assert.ok(q2);

    assert.equal((await w.admin.call("POST", `/api/providers/${a.id}/reviews`, { rating: 6 })).status, 400);
    assert.equal((await w.admin.call("POST", `/api/providers/${a.id}/reviews`, { rating: 5, request_id: m })).status, 400, "chamado ainda não concluído");
    await db.query("UPDATE maintenance_requests SET status = 'concluida' WHERE id = $1", [m]);
    const r1 = await w.admin.call("POST", `/api/providers/${a.id}/reviews`, { rating: 5, request_id: m, comment: "Rápido e limpo" });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.item.rating, 5);
    assert.equal((await w.admin.call("POST", `/api/providers/${a.id}/reviews`, { rating: 4, request_id: m })).status, 409, "uma avaliação por serviço");
    await w.admin.call("POST", `/api/providers/${a.id}/reviews`, { rating: 3 });
    assert.equal((await w.admin.call("GET", "/api/providers")).body.items[0].rating, 4);
    assert.equal((await w.admin.call("GET", `/api/providers/${a.id}/reviews`)).body.items.length, 2);
    assert.equal((await w.tenantClient.call("GET", "/api/providers")).status, 403);
    const other = await world("2");
    assert.equal((await other.admin.call("PATCH", `/api/providers/${a.id}`, { name: "Hack" })).status, 404);
    assert.equal((await w.admin.call("DELETE", `/api/providers/${b.id}`)).status, 204);
  });
});

describe("manutenção preventiva recorrente", () => {
  it("abre o chamado na antecedência, avança a data e não repete", async () => {
    const { runMaintenancePlans } = await import("../src/ops.js");
    const w = await world("3");
    const body = { unit_id: w.unitId, title: "Limpar caixa d'água", category: "hidraulica", description: "Limpeza semestral", interval_months: 6, next_due: inDays(5), lead_days: 7 };
    assert.equal((await w.admin.call("POST", "/api/maintenance-plans", { ...body, interval_months: 0 })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/maintenance-plans", { ...body, category: "x" })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/maintenance-plans", { ...body, next_due: "ontem" })).status, 400);
    const far = (await w.admin.call("POST", "/api/maintenance-plans", { ...body, title: "Dedetização anual", next_due: inDays(60), interval_months: 12 })).body.item;
    const plan = (await w.admin.call("POST", "/api/maintenance-plans", body)).body.item;

    assert.equal(await runMaintenancePlans(), 1, "só o plano que entrou na antecedência de 7 dias");
    const list = (await w.admin.call("GET", "/api/maintenance")).body.items as { title: string; description: string }[];
    const gen = list.find((m) => m.title === "[Preventiva] Limpar caixa d'água")!;
    assert.ok(gen);
    const after = (await w.admin.call("GET", "/api/maintenance-plans")).body.items.find((p: { id: number }) => p.id === plan.id);
    const expected = new Date(Date.UTC(Number(inDays(5).slice(0, 4)), Number(inDays(5).slice(5, 7)) - 1 + 6, 1));
    assert.equal(after.next_due.slice(0, 7), expected.toISOString().slice(0, 7), "próxima daqui a 6 meses");
    assert.equal(after.last_generated_for, inDays(5));
    assert.equal(await runMaintenancePlans(), 0, "não repete");
    assert.equal(list.filter((m) => m.title.startsWith("[Preventiva] Dedetização")).length, 0);

    assert.equal((await w.admin.call("PATCH", `/api/maintenance-plans/${far.id}`, { active: false })).body.item.active, false);
    assert.equal(await runMaintenancePlans(inDays(70)), 0, "plano pausado não gera");
    await w.admin.call("PATCH", `/api/maintenance-plans/${far.id}`, { active: true });
    assert.equal(await runMaintenancePlans(inDays(70)), 1);
    assert.equal((await w.tenantClient.call("GET", "/api/maintenance-plans")).status, 403);
    assert.equal((await w.admin.call("DELETE", `/api/maintenance-plans/${plan.id}`)).status, 204);
  });
});

describe("enquetes", () => {
  it("notifica o público, aceita um voto por pessoa, esconde o resultado até votar e respeita anonimato e prazo", async () => {
    const { closeExpiredPolls } = await import("../src/ops.js");
    const { db } = await import("../src/db.js");
    const w = await world("4");
    const body = { question: "Podemos trocar o portão?", audience: "inquilinos", options: ["Sim", "Não"] };
    assert.equal((await w.admin.call("POST", "/api/polls", { ...body, options: ["Só uma"] })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/polls", { ...body, options: ["Sim", "sim"] })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/polls", { ...body, audience: "vizinhos" })).status, 400);
    assert.equal((await w.admin.call("POST", "/api/polls", { ...body, closes_at: "2020-01-01" })).status, 400);
    const created = await w.admin.call("POST", "/api/polls", { ...body, anonymous: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.recipients, 1);
    const notes = (await w.tenantClient.call("GET", "/api/notifications")).body.items.map((n: { title: string }) => n.title);
    assert.ok(notes.includes("Nova enquete"));

    const list = (await w.tenantClient.call("GET", "/api/portal/polls")).body.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].results, null, "antes de votar não vê o resultado");
    assert.equal((await w.ownerClient.call("GET", "/api/portal/polls")).body.items.length, 0, "proprietário fora do público");
    const sim = list[0].options[0].id;
    assert.equal((await w.tenantClient.call("POST", `/api/portal/polls/${created.body.id}/vote`, { option_id: 999999 })).status, 400);
    const vote = await w.tenantClient.call("POST", `/api/portal/polls/${created.body.id}/vote`, { option_id: sim });
    assert.equal(vote.status, 201, JSON.stringify(vote.body));
    assert.equal(vote.body.total_votes, 1);
    assert.equal(vote.body.options[0].percent, 100);
    assert.equal((await w.tenantClient.call("POST", `/api/portal/polls/${created.body.id}/vote`, { option_id: sim })).status, 409, "um voto só");
    assert.equal((await w.ownerClient.call("POST", `/api/portal/polls/${created.body.id}/vote`, { option_id: sim })).status, 404);
    assert.equal((await w.admin.call("POST", `/api/portal/polls/${created.body.id}/vote`, { option_id: sim })).status, 403, "equipe não vota");

    const detail = (await w.admin.call("GET", `/api/polls/${created.body.id}`)).body;
    assert.equal(detail.total_votes, 1);
    assert.equal(detail.voters, undefined, "anônima: a equipe também não vê quem votou");
    const open = (await w.admin.call("POST", "/api/polls", { ...body, question: "Pintar a fachada de azul?" })).body.id;
    await w.tenantClient.call("POST", `/api/portal/polls/${open}/vote`, { option_id: (await w.tenantClient.call("GET", "/api/portal/polls")).body.items.find((p: { id: number }) => p.id === open).options[1].id });
    assert.equal((await w.admin.call("GET", `/api/polls/${open}`)).body.voters.length, 1, "não anônima: a equipe vê");

    await db.query("UPDATE polls SET closes_at = now() - interval '1 minute' WHERE id = $1", [open]);
    assert.equal(await closeExpiredPolls(), 1);
    assert.equal((await w.tenantClient.call("POST", `/api/portal/polls/${open}/vote`, { option_id: sim })).status, 409);
    assert.equal((await w.admin.call("POST", `/api/polls/${created.body.id}/close`)).status, 200);
    assert.equal((await w.admin.call("POST", `/api/polls/${created.body.id}/close`)).status, 409);
    assert.equal((await w.tenantClient.call("GET", "/api/polls")).status, 403);
  });

  it("filtra por imóvel: só quem tem vínculo com aquele imóvel recebe", async () => {
    const a = await world("5");
    const b = await world("6");
    const poll = await a.admin.call("POST", "/api/polls", { question: "Horário da portaria?", audience: "todos", property_id: a.propertyId, options: ["8h", "9h"] });
    assert.equal(poll.body.recipients, 2, "inquilino e proprietário daquele imóvel");
    assert.equal((await b.tenantClient.call("GET", "/api/portal/polls")).body.items.length, 0);
    assert.equal((await a.admin.call("POST", "/api/polls", { question: "Imóvel de outro?", audience: "todos", property_id: b.propertyId, options: ["a", "b"] })).status, 400);
  });
});

describe("ocorrências e multas", () => {
  it("registra, notifica, aceita contestação, aplica multa como cobrança e arquiva", async () => {
    const w = await world("7");
    const bad = (b: Record<string, unknown>) => w.admin.call("POST", "/api/incidents", { unit_id: w.unitId, category: "barulho", description: "Festa depois das 22h", ...b });
    assert.equal((await bad({ category: "luz" })).status, 400);
    assert.equal((await bad({ description: "oi" })).status, 400);
    assert.equal((await bad({ occurred_at: "2999-01-01T10:00:00Z" })).status, 400);
    assert.equal((await bad({ unit_id: 999999 })).status, 400);
    const inc = (await bad({})).body.item;
    assert.equal(inc.status, "registrada");
    assert.equal((await w.tenantClient.call("GET", "/api/portal/tenant/incidents")).body.items.length, 0, "interna até notificar");
    assert.equal((await w.admin.call("POST", `/api/incidents/${inc.id}/fine`, { amount_cents: 20000 })).status, 409, "precisa notificar antes");

    assert.equal((await w.admin.call("POST", `/api/incidents/${inc.id}/notify`)).status, 200);
    assert.equal((await w.admin.call("POST", `/api/incidents/${inc.id}/notify`)).status, 409);
    const mine = (await w.tenantClient.call("GET", "/api/portal/tenant/incidents")).body.items;
    assert.equal(mine.length, 1);
    assert.ok((await w.tenantClient.call("GET", "/api/notifications")).body.items.some((n: { category: string }) => n.category === "ocorrencia"));

    assert.equal((await w.tenantClient.call("POST", `/api/portal/tenant/incidents/${inc.id}/contest`, { text: "oi" })).status, 400);
    assert.equal((await w.tenantClient.call("POST", `/api/portal/tenant/incidents/${inc.id}/contest`, { text: "Eu estava viajando nesse dia." })).status, 201);
    assert.equal((await w.tenantClient.call("POST", `/api/portal/tenant/incidents/${inc.id}/contest`, { text: "Outra vez" })).status, 409, "uma contestação");
    assert.ok((await w.admin.call("GET", "/api/notifications")).body.items.some((n: { title: string }) => n.title === "Ocorrência contestada"));

    assert.equal((await w.admin.call("POST", `/api/incidents/${inc.id}/fine`, { amount_cents: 0 })).status, 400);
    const fine = await w.admin.call("POST", `/api/incidents/${inc.id}/fine`, { amount_cents: 20000 });
    assert.equal(fine.status, 200, JSON.stringify(fine.body));
    assert.equal(fine.body.item.status, "multada");
    assert.equal(fine.body.item.contestation, "Eu estava viajando nesse dia.");
    const charge = (await w.admin.call("GET", `/api/charges?month=${today.slice(0, 7)}`)).body.items.find((c: { kind: string }) => c.kind === "multa");
    assert.equal(charge.amount_cents, 20000);
    assert.match(charge.description, /ocorrência nº/);
    assert.equal((await w.admin.call("POST", `/api/incidents/${inc.id}/fine`, { amount_cents: 1000 })).status, 409, "uma multa só");

    const arch = await w.admin.call("POST", `/api/incidents/${inc.id}/archive`, { note: "Conversado com o morador" });
    assert.equal(arch.body.item.status, "arquivada");
    assert.equal(arch.body.item.resolution_note, "Conversado com o morador");
    assert.equal((await w.admin.call("GET", "/api/incidents?status=arquivada")).body.items.length, 1);
    assert.equal((await w.tenantClient.call("GET", "/api/incidents")).status, 403);
    const other = await world("8");
    assert.equal((await other.tenantClient.call("POST", `/api/portal/tenant/incidents/${inc.id}/contest`, { text: "Não é meu" })).status, 409, "isolado");
  });
});
