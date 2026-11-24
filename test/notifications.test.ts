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

const brToday = (plusDays = 0) => {
  const d = new Date(Date.now() + plusDays * 86_400_000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(d);
};

async function memberClient(admin: Client, email: string, role: string, extra: Record<string, unknown> = {}) {
  const inv = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  assert.equal((await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Membro", password: "senha-segura-123" })).status, 201);
  return c;
}

interface W {
  admin: Client;
  tenant: Client;
  owner: Client;
  ids: { owner: number; property: number; unit: number; tenant: number; lease: number };
}

/** Org com 1 imóvel, 1 contrato vigente, e logins de inquilino e proprietário já vinculados. */
async function world(tag: string): Promise<W> {
  const admin = await register(base, `n${tag}@x.com`, `Notif ${tag}`);
  const owner = (await admin.call("POST", "/api/owners", { name: `Dono ${tag}`, document: `1${tag}` })).body.item;
  const property = (await admin.call("POST", "/api/properties", { name: `Imóvel ${tag}`, type: "casa" })).body.item;
  await admin.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: `U${tag}` })).body.item;
  const tenant = (await admin.call("POST", "/api/tenants", { name: `Inquilino ${tag}`, document: `2${tag}` })).body.item;
  const lease = (
    await admin.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })
  ).body.lease;
  await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  return {
    admin,
    tenant: await memberClient(admin, `nt${tag}@x.com`, "inquilino", { tenantId: tenant.id }),
    owner: await memberClient(admin, `no${tag}@x.com`, "proprietario", { ownerId: owner.id }),
    ids: { owner: owner.id, property: property.id, unit: unit.id, tenant: tenant.id, lease: lease.id },
  };
}

const inbox = async (c: Client, query = "") => (await c.call("GET", `/api/notifications${query}`)).body as {
  items: { id: number; title: string; body: string | null; category: string; kind: string; read_at: string | null }[];
  unread: number;
};
const titles = async (c: Client) => (await inbox(c)).items.map((i) => i.title);

describe("notificações — eventos", () => {
  it("pagamento notifica só o inquilino do contrato; estorno também", async () => {
    const w = await world("1");
    await w.admin.call("POST", "/api/charges/generate", { month: "2024-03" });
    const charge = (await w.admin.call("GET", "/api/charges?month=2024-03")).body.items[0];
    const pay = await w.admin.call("POST", "/api/payments", {
      lease_id: w.ids.lease, received_at: "2024-03-10", amount_cents: 100000, method: "pix",
      allocations: [{ charge_id: charge.id, amount_cents: 100000 }],
    });
    assert.equal(pay.status, 201);

    const t = await inbox(w.tenant);
    assert.equal(t.unread, 1);
    assert.equal(t.items[0]!.title, "Pagamento identificado");
    assert.match(t.items[0]!.body!, /R\$ 1\.000,00 · recibo nº 1/);
    assert.equal(t.items[0]!.category, "financeiro");
    assert.equal((await inbox(w.owner)).items.length, 0, "proprietário não recebe");
    assert.equal((await inbox(w.admin)).items.length, 0, "quem registrou não é avisado");

    await w.admin.call("POST", `/api/payments/${pay.body.payment.id}/void`, { reason: "Pix devolvido" });
    assert.deepEqual(await titles(w.tenant), ["Pagamento estornado", "Pagamento identificado"]);
  });

  it("manutenção: status e comentário público avisam o inquilino; nota interna não; cliente avisa a equipe", async () => {
    const w = await world("2");
    const adminId = (await w.admin.call("GET", "/api/auth/me")).body.user.id;
    const req = (await w.tenant.call("POST", "/api/portal/tenant/maintenance", {
      lease_id: w.ids.lease, category: "eletrica", title: "Tomada", description: "Sem energia",
    })).body.id;
    const staff = await inbox(w.admin);
    assert.equal(staff.items[0]!.title, "Chamado: Tomada");
    assert.match(staff.items[0]!.body!, /Nova solicitação/);
    assert.equal(staff.items[0]!.kind, "maintenance_opened");

    await w.admin.call("POST", `/api/maintenance/${req}/comments`, { message: "Nota interna secreta" });
    assert.equal((await inbox(w.tenant)).items.length, 0, "nota interna não notifica");
    await w.admin.call("POST", `/api/maintenance/${req}/comments`, { message: "Eletricista na terça", client_visible: true });
    await w.admin.call("POST", `/api/maintenance/${req}/status`, { status: "em_analise" });
    const t = await inbox(w.tenant);
    assert.deepEqual(t.items.map((i) => i.body), ["Status: Em análise", "Eletricista na terça"]);
    assert.ok(!JSON.stringify(t).includes("secreta"));

    // Com responsável definido, só ele recebe o que o cliente faz.
    const col = await memberClient(w.admin, "n2col@x.com", "colaborador");
    const colId = (await col.call("GET", "/api/auth/me")).body.user.id;
    await w.admin.call("PATCH", `/api/maintenance/${req}`, { assigned_to: colId });
    const before = (await inbox(w.admin)).items.length;
    await w.tenant.call("POST", `/api/portal/tenant/maintenance/${req}/comments`, { message: "Alguma novidade?" });
    assert.equal((await inbox(col)).items[0]!.kind, "maintenance_comment");
    assert.equal((await inbox(w.admin)).items.length, before, "o administrador não recebe quando há responsável");
    assert.ok(adminId > 0);
  });

  it("vistoria: agendamento avisa o inquilino; laudo concluído avisa inquilino e proprietário", async () => {
    const w = await world("3");
    const id = (await w.admin.call("POST", "/api/inspections", { unit_id: w.ids.unit, type: "entrada", scheduled_for: "2030-05-10" })).body.id;
    const sched = await inbox(w.tenant);
    assert.equal(sched.items[0]!.title, "Vistoria de entrada agendada");
    assert.equal(sched.items[0]!.body, "Prevista para 10/05/2030");
    assert.equal((await inbox(w.owner)).items.length, 0);

    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" });
    for (const it of (await w.admin.call("GET", `/api/inspections/${id}`)).body.items) {
      await w.admin.call("PATCH", `/api/inspections/${id}/items/${it.id}`, { condition: "bom" });
    }
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "concluida" });
    assert.equal((await inbox(w.tenant)).items[0]!.kind, "inspection_completed");
    assert.equal((await inbox(w.owner)).items[0]!.kind, "inspection_completed");
  });
});

describe("notificações — caixa de entrada e preferências", () => {
  it("lê, marca como lida, marca todas e isola entre usuários", async () => {
    const w = await world("4");
    const other = await memberClient(w.admin, "n4o@x.com", "inquilino", { tenantId: (await w.admin.call("POST", "/api/tenants", { name: "Vizinho", document: "9" })).body.item.id });
    for (let i = 0; i < 3; i++) await w.admin.call("POST", "/api/inspections", { unit_id: w.ids.unit, type: "periodica", scheduled_for: `2030-0${i + 1}-10` });

    const all = await inbox(w.tenant);
    assert.equal(all.unread, 3);
    assert.equal((await w.tenant.call("GET", "/api/notifications/count")).body.unread, 3);
    const first = all.items[0]!;
    assert.equal((await other.call("POST", `/api/notifications/${first.id}/read`)).status, 404, "não lê a de outro");
    assert.equal((await w.tenant.call("POST", `/api/notifications/${first.id}/read`)).status, 204);
    assert.equal((await inbox(w.tenant)).unread, 2);
    assert.equal((await inbox(w.tenant, "?unread=1")).items.length, 2);
    assert.equal((await w.tenant.call("POST", "/api/notifications/read-all")).status, 204);
    assert.equal((await inbox(w.tenant)).unread, 0);
    assert.equal((await inbox(w.tenant)).items.length, 3, "continuam no histórico");
    assert.equal((await inbox(other)).items.length, 0);
    assert.equal((await new Client(base).call("GET", "/api/notifications")).status, 401);
    assert.equal((await w.tenant.call("POST", "/api/notifications/abc/read")).status, 404);
  });

  it("respeita a preferência por categoria", async () => {
    const w = await world("5");
    const prefs = (await w.tenant.call("GET", "/api/notifications/preferences")).body;
    assert.equal(prefs.items.length, 6);
    assert.ok(prefs.items.every((p: { in_app: boolean }) => p.in_app));
    assert.deepEqual(prefs.channels, { in_app: true, email: false, whatsapp: false, push: false });

    assert.equal((await w.tenant.call("PUT", "/api/notifications/preferences", { category: "vistoria", in_app: false })).status, 204);
    assert.equal((await w.tenant.call("PUT", "/api/notifications/preferences", { category: "xx", in_app: false })).status, 400);
    assert.equal((await w.tenant.call("PUT", "/api/notifications/preferences", { category: "vistoria", in_app: "não" })).status, 400);
    await w.admin.call("POST", "/api/inspections", { unit_id: w.ids.unit, type: "entrada", scheduled_for: "2030-01-10" });
    assert.equal((await inbox(w.tenant)).items.length, 0, "categoria desligada");

    await w.tenant.call("PUT", "/api/notifications/preferences", { category: "vistoria", in_app: true });
    await w.admin.call("POST", "/api/inspections", { unit_id: w.ids.unit, type: "saida", scheduled_for: "2030-02-10" });
    assert.equal((await inbox(w.tenant)).items.length, 1);
    const after = (await w.tenant.call("GET", "/api/notifications/preferences")).body.items.find((p: { category: string }) => p.category === "vistoria");
    assert.equal(after.in_app, true);
  });

  it("chaves de API não têm caixa de entrada", async () => {
    const a = await register(base, "n6@x.com", "Notif 6");
    const key = (await a.call("POST", "/api/api-keys", { name: "k" })).body.token;
    const res = await fetch(base + "/api/notifications", { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 403);
  });
});

describe("comunicados", () => {
  it("rascunho não notifica nem aparece; publicar entrega só ao público certo", async () => {
    const w = await world("7");
    const draft = await w.admin.call("POST", "/api/announcements", { title: "Obras na fachada", body: "Entre 10 e 20.", audience: "inquilinos" });
    assert.equal(draft.status, 201);
    assert.equal((await w.tenant.call("GET", "/api/portal/announcements")).body.items.length, 0);
    assert.equal((await inbox(w.tenant)).items.length, 0);

    const pub = await w.admin.call("POST", `/api/announcements/${draft.body.id}/publish`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.recipients, 1);
    assert.equal((await inbox(w.tenant)).items[0]!.title, "Obras na fachada");
    assert.equal((await inbox(w.owner)).items.length, 0, "público = inquilinos");
    assert.equal((await inbox(w.admin)).items.length, 0, "equipe não recebe o próprio comunicado");
    assert.equal((await w.tenant.call("GET", "/api/portal/announcements")).body.items.length, 1);
    assert.equal((await w.owner.call("GET", "/api/portal/announcements")).body.items.length, 0);

    assert.equal((await w.admin.call("POST", `/api/announcements/${draft.body.id}/publish`)).status, 409, "uma vez só");
    assert.equal((await w.admin.call("PATCH", `/api/announcements/${draft.body.id}`, { title: "x", body: "y", audience: "todos" })).status, 409);
    assert.equal((await w.admin.call("DELETE", `/api/announcements/${draft.body.id}`)).status, 409);

    assert.equal((await w.admin.call("POST", `/api/announcements/${draft.body.id}/archive`)).status, 204);
    assert.equal((await w.tenant.call("GET", "/api/portal/announcements")).body.items.length, 0, "arquivado some do portal");
    assert.equal((await w.admin.call("POST", `/api/announcements/${draft.body.id}/archive`)).status, 404);
  });

  it("público 'todos', 'proprietarios' e 'imovel' (só quem tem vínculo com aquele imóvel)", async () => {
    const w = await world("8");
    // Segundo imóvel com outro inquilino e outro proprietário, ambos logados.
    const owner2 = (await w.admin.call("POST", "/api/owners", { name: "Dono 2", document: "802" })).body.item;
    const prop2 = (await w.admin.call("POST", "/api/properties", { name: "Imóvel 2", type: "casa" })).body.item;
    await w.admin.call("PUT", `/api/properties/${prop2.id}/owners`, { ownerIds: [owner2.id] });
    const unit2 = (await w.admin.call("POST", "/api/units", { property_id: prop2.id, identifier: "U2" })).body.item;
    const tenant2 = (await w.admin.call("POST", "/api/tenants", { name: "Inquilino 2", document: "803" })).body.item;
    const lease2 = (await w.admin.call("POST", "/api/leases", { unit_id: unit2.id, tenantIds: [tenant2.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 50000, due_day: 5 })).body.lease;
    await w.admin.call("POST", `/api/leases/${lease2.id}/status`, { status: "vigente" });
    const t2 = await memberClient(w.admin, "n8t2@x.com", "inquilino", { tenantId: tenant2.id });
    const o2 = await memberClient(w.admin, "n8o2@x.com", "proprietario", { ownerId: owner2.id });

    const publish = async (body: Record<string, unknown>) => {
      const id = (await w.admin.call("POST", "/api/announcements", { title: "T", body: "B", ...body })).body.id;
      return (await w.admin.call("POST", `/api/announcements/${id}/publish`)).body.recipients as number;
    };
    assert.equal(await publish({ audience: "todos" }), 4);
    assert.equal(await publish({ audience: "proprietarios" }), 2);
    assert.equal(await publish({ audience: "imovel", property_id: prop2.id }), 2, "inquilino e proprietário do imóvel 2");

    // Só o inquilino/proprietário do imóvel 2 vê o comunicado "imovel"; o do imóvel 1 não.
    const visible = async (c: Client) => (await c.call("GET", "/api/portal/announcements")).body.items.length;
    assert.equal(await visible(t2), 2, "todos + imovel");
    assert.equal(await visible(o2), 3, "todos + proprietarios + imovel");
    assert.equal(await visible(w.tenant), 1, "só 'todos'");
    assert.equal(await visible(w.owner), 2, "todos + proprietarios");
  });

  it("valida, restringe à equipe e isola organizações", async () => {
    const a = await world("9");
    const b = await register(base, "n9b@x.com", "Notif 9B");
    const good = { title: "Aviso", body: "Texto", audience: "todos" };
    assert.equal((await a.admin.call("POST", "/api/announcements", { ...good, title: " " })).status, 400);
    assert.equal((await a.admin.call("POST", "/api/announcements", { ...good, audience: "vizinhos" })).status, 400);
    assert.equal((await a.admin.call("POST", "/api/announcements", { ...good, audience: "imovel" })).status, 400, "sem imóvel");
    assert.equal((await a.admin.call("POST", "/api/announcements", { ...good, audience: "imovel", property_id: 999999 })).status, 400);
    const foreign = (await b.call("POST", "/api/properties", { name: "De outro", type: "casa" })).body.item;
    assert.equal((await a.admin.call("POST", "/api/announcements", { ...good, audience: "imovel", property_id: foreign.id })).status, 400, "imóvel de outra organização");

    const id = (await a.admin.call("POST", "/api/announcements", good)).body.id;
    assert.equal((await a.admin.call("PATCH", `/api/announcements/${id}`, { ...good, title: "Aviso 2" })).status, 204);
    assert.equal((await a.tenant.call("GET", "/api/announcements")).status, 403);
    assert.equal((await a.tenant.call("POST", `/api/announcements/${id}/publish`)).status, 403);
    assert.equal((await b.call("POST", `/api/announcements/${id}/publish`)).status, 404);
    assert.equal((await b.call("GET", "/api/announcements")).body.items.length, 0);
    assert.equal((await a.admin.call("DELETE", `/api/announcements/${id}`)).status, 204);
  });
});

describe("lembretes automáticos", () => {
  it("avisa vencimento próximo, atraso e fim de contrato, sem repetir", async () => {
    const w = await world("10");
    // Atraso: aluguel de 2024-03 sem pagar. Vence em breve: multa avulsa daqui a 2 dias.
    await w.admin.call("POST", "/api/charges/generate", { month: "2024-03" });
    await w.admin.call("POST", "/api/charges", { lease_id: w.ids.lease, kind: "multa", description: "Taxa extra", due_date: brToday(2), amount_cents: 7000 });
    // Contrato terminando em 30 dias, em outra unidade.
    const unit2 = (await w.admin.call("POST", "/api/units", { property_id: w.ids.property, identifier: "U-fim" })).body.item;
    const tenant2 = (await w.admin.call("POST", "/api/tenants", { name: "Inq Fim", document: "1010" })).body.item;
    const lease2 = (await w.admin.call("POST", "/api/leases", { unit_id: unit2.id, tenantIds: [tenant2.id], start_date: "2024-01-01", end_date: brToday(30), rent_cents: 50000, due_day: 5 })).body.lease;
    await w.admin.call("POST", `/api/leases/${lease2.id}/status`, { status: "vigente" });

    const first = await w.admin.call("POST", "/api/reminders/run");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { dueSoon: 1, overdue: 1, overdueDigest: 1, leasesEnding: 1 });

    assert.deepEqual((await titles(w.tenant)).sort(), ["Cobrança em atraso", "Cobrança vence em breve"]);
    const adminTitles = await titles(w.admin);
    assert.ok(adminTitles.includes("Contrato próximo do fim"));
    assert.ok(adminTitles.includes("1 cobrança(s) em atraso"));
    assert.equal((await inbox(w.owner)).items.length, 0);

    const second = await w.admin.call("POST", "/api/reminders/run");
    assert.deepEqual(second.body, { dueSoon: 0, overdue: 0, overdueDigest: 0, leasesEnding: 0 }, "idempotente");
    assert.equal((await inbox(w.tenant)).items.length, 2);

    const col = await memberClient(w.admin, "n10c@x.com", "colaborador");
    assert.equal((await col.call("POST", "/api/reminders/run")).status, 403, "só admin dispara manualmente");
    assert.equal((await w.tenant.call("POST", "/api/reminders/run")).status, 403);
  });

  it("cobrança paga ou cancelada não gera lembrete, e uma organização não vê a outra", async () => {
    const a = await world("11");
    const b = await world("12");
    await a.admin.call("POST", "/api/charges/generate", { month: "2024-03" });
    const charge = (await a.admin.call("GET", "/api/charges?month=2024-03")).body.items[0];
    await a.admin.call("POST", "/api/payments", { lease_id: a.ids.lease, received_at: "2024-03-10", amount_cents: 100000, method: "pix", allocations: [{ charge_id: charge.id, amount_cents: 100000 }] });
    const run = await a.admin.call("POST", "/api/reminders/run");
    assert.equal(run.body.overdue, 0, "paga não é atraso");
    assert.equal((await b.admin.call("POST", "/api/reminders/run")).body.overdue, 0);
    assert.equal((await titles(b.tenant)).length, 0);
  });

  it("a limpeza remove notificações antigas e preserva as recentes", async () => {
    const w = await world("13");
    await w.admin.call("POST", "/api/inspections", { unit_id: w.ids.unit, type: "entrada", scheduled_for: "2030-01-10" });
    const { db } = await import("../src/db.js");
    const me = (await w.tenant.call("GET", "/api/auth/me")).body;
    await db.query(
      "INSERT INTO notifications (organization_id, user_id, category, kind, title, created_at) VALUES ($1, $2, 'comunicado', 'x', 'Muito antiga', now() - interval '200 days')",
      [me.organization.id, me.user.id],
    );
    const { pruneNotifications } = await import("../src/reminders.js");
    await pruneNotifications();
    const left = await titles(w.tenant);
    assert.ok(!left.includes("Muito antiga"));
    assert.equal(left.length, 1);
  });
});
