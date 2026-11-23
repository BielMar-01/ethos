import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, JPEG, PNG, download, register, startServer, upload } from "./helpers.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

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
  ownerId: number;
  unitId: number;
  tenantId: number;
  leaseId: number;
}

/** Imóvel com proprietário, unidade, inquilino e contrato vigente. */
async function world(tag: string): Promise<W> {
  const admin = await register(base, `m${tag}@x.com`, `Maint ${tag}`);
  const owner = (await admin.call("POST", "/api/owners", { name: `Dono ${tag}`, document: `1${tag}` })).body.item;
  const property = (await admin.call("POST", "/api/properties", { name: `Imóvel ${tag}`, type: "casa" })).body.item;
  await admin.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: `U${tag}` })).body.item;
  const tenant = (await admin.call("POST", "/api/tenants", { name: `Inquilino ${tag}`, document: `2${tag}` })).body.item;
  const lease = (
    await admin.call("POST", "/api/leases", {
      unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5,
    })
  ).body.lease;
  await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  return { admin, ownerId: owner.id, unitId: unit.id, tenantId: tenant.id, leaseId: lease.id };
}

const open = (c: Client, unitId: number, extra: Record<string, unknown> = {}) =>
  c.call("POST", "/api/maintenance", { unit_id: unitId, category: "hidraulica", title: "Vazamento na pia", description: "Pinga o tempo todo", priority: "alta", ...extra });

const status = (c: Client, id: number, s: string, extra: Record<string, unknown> = {}) =>
  c.call("POST", `/api/maintenance/${id}/status`, { status: s, ...extra });

describe("manutenção — equipe", () => {
  it("abre chamado ligado ao contrato vigente e valida os campos", async () => {
    const w = await world("1");
    const r = await open(w.admin, w.unitId);
    assert.equal(r.status, 201);
    const d = (await w.admin.call("GET", `/api/maintenance/${r.body.id}`)).body;
    assert.equal(d.item.status, "aberta");
    assert.equal(d.item.lease_id, w.leaseId);
    assert.equal(d.item.property_name, "Imóvel 1");
    assert.equal(d.updates.length, 1);

    assert.equal((await open(w.admin, w.unitId, { category: "magia" })).status, 400);
    assert.equal((await open(w.admin, w.unitId, { priority: "mega" })).status, 400);
    assert.equal((await open(w.admin, w.unitId, { title: " " })).status, 400);
    assert.equal((await open(w.admin, 999999)).status, 400);
    assert.equal((await w.admin.call("GET", "/api/maintenance?status=xx")).status, 400);
  });

  it("segue o fluxo: análise → orçamento → aprovação → execução → conclusão com custo", async () => {
    const w = await world("2");
    const id = (await open(w.admin, w.unitId)).body.id;

    assert.equal((await status(w.admin, id, "concluida")).status, 409, "não pula etapas");
    assert.equal((await status(w.admin, id, "aprovada")).status, 409, "aprovada só por orçamento");
    assert.equal((await status(w.admin, id, "em_analise")).status, 200);
    assert.equal((await status(w.admin, id, "aguardando_aprovacao")).status, 409, "sem orçamento");

    const q1 = (await w.admin.call("POST", `/api/maintenance/${id}/quotes`, { supplier: "Hidro Ltda", amount_cents: 45000 })).body.id;
    const q2 = (await w.admin.call("POST", `/api/maintenance/${id}/quotes`, { supplier: "Encanador Zé", amount_cents: 38000, notes: "sem nota" })).body.id;
    let d = (await w.admin.call("GET", `/api/maintenance/${id}`)).body;
    assert.equal(d.item.status, "aguardando_aprovacao", "primeiro orçamento envia para aprovação");
    assert.equal(d.quotes.length, 2);

    const col = await memberClient(w.admin, "m2col@x.com", "colaborador");
    assert.equal((await col.call("POST", `/api/maintenance/${id}/quotes/${q2}/approve`)).status, 403, "só admin aprova");
    assert.equal((await w.admin.call("POST", `/api/maintenance/${id}/quotes/${q2}/approve`)).status, 200);
    d = (await w.admin.call("GET", `/api/maintenance/${id}`)).body;
    assert.equal(d.item.status, "aprovada");
    assert.deepEqual(d.quotes.map((q: { id: number; status: string }) => [q.id, q.status]), [[q1, "recusado"], [q2, "aprovado"]]);
    assert.equal((await w.admin.call("POST", `/api/maintenance/${id}/quotes/${q2}/approve`)).status, 409, "já decidido");
    assert.equal((await w.admin.call("POST", `/api/maintenance/${id}/quotes`, { supplier: "X", amount_cents: 1 })).status, 409, "fora da fase de orçamento");

    assert.equal((await status(w.admin, id, "em_execucao")).status, 200);
    assert.equal((await status(w.admin, id, "concluida", { cost_cents: -1 })).status, 400);
    assert.equal((await status(w.admin, id, "concluida", { cost_cents: 39500 })).status, 200);
    d = (await w.admin.call("GET", `/api/maintenance/${id}`)).body;
    assert.equal(d.item.status, "concluida");
    assert.equal(d.item.cost_cents, 39500);
    assert.ok(d.item.completed_at);

    // Encerrado: não edita, não aceita foto nem novo status.
    assert.equal((await w.admin.call("PATCH", `/api/maintenance/${id}`, { priority: "baixa" })).status, 409);
    assert.equal((await upload(w.admin, `/api/maintenance/${id}/photos`, JPEG)).status, 409);
    assert.equal((await status(w.admin, id, "em_execucao")).status, 409);
  });

  it("cancelamento exige motivo; notas são internas por padrão; responsável é da equipe", async () => {
    const w = await world("3");
    const other = await register(base, "m3other@x.com", "Outra");
    const otherUser = (await other.call("GET", "/api/auth/me")).body.user.id;
    const id = (await open(w.admin, w.unitId)).body.id;

    assert.equal((await status(w.admin, id, "cancelada")).status, 400);
    await w.admin.call("POST", `/api/maintenance/${id}/comments`, { message: "Cliente é chato, cobrar visita" });
    await w.admin.call("POST", `/api/maintenance/${id}/comments`, { message: "Vamos agendar", client_visible: true });
    const updates = (await w.admin.call("GET", `/api/maintenance/${id}`)).body.updates;
    assert.equal(updates.find((u: { message: string }) => u.message.startsWith("Cliente"))!.client_visible, false);
    assert.equal(updates.find((u: { message: string }) => u.message === "Vamos agendar")!.client_visible, true);
    assert.equal((await w.admin.call("POST", `/api/maintenance/${id}/comments`, { message: " " })).status, 400);

    const me = (await w.admin.call("GET", "/api/auth/me")).body.user.id;
    assert.equal((await w.admin.call("PATCH", `/api/maintenance/${id}`, { assigned_to: otherUser })).status, 400, "usuário de outra organização");
    assert.equal((await w.admin.call("PATCH", `/api/maintenance/${id}`, { assigned_to: me })).status, 204);
    assert.equal((await w.admin.call("GET", "/api/maintenance")).body.items[0].assigned_name, "Admin Maint 3");
    assert.equal((await w.admin.call("PATCH", `/api/maintenance/${id}`, {})).status, 400);

    assert.equal((await status(w.admin, id, "cancelada", { reason: "Resolvido pelo morador" })).status, 200);
    assert.equal((await w.admin.call("GET", `/api/maintenance/${id}`)).body.item.cancelled_reason, "Resolvido pelo morador");
  });

  it("lista priorizando abertos e urgentes; isola organizações", async () => {
    const w = await world("4");
    const other = await world("5");
    const low = (await open(w.admin, w.unitId, { priority: "baixa", title: "Baixa" })).body.id;
    const urgent = (await open(w.admin, w.unitId, { priority: "urgente", title: "Urgente" })).body.id;
    const done = (await open(w.admin, w.unitId, { priority: "urgente", title: "Encerrado" })).body.id;
    await status(w.admin, done, "cancelada", { reason: "duplicado" });

    const items = (await w.admin.call("GET", "/api/maintenance")).body.items;
    assert.deepEqual(items.map((i: { title: string }) => i.title), ["Urgente", "Baixa", "Encerrado"]);
    assert.equal((await w.admin.call("GET", "/api/maintenance?status=aberta")).body.items.length, 2);
    assert.equal((await other.admin.call("GET", "/api/maintenance")).body.items.length, 0);
    assert.equal((await other.admin.call("GET", `/api/maintenance/${low}`)).status, 404);
    assert.equal((await other.admin.call("POST", `/api/maintenance/${urgent}/comments`, { message: "x" })).status, 404);
    assert.equal((await other.admin.call("POST", `/api/maintenance/${urgent}/status`, { status: "em_analise" })).status, 404);
    assert.equal((await open(other.admin, w.unitId)).status, 400, "unidade de outra organização");
  });
});

describe("fotos", () => {
  it("valida o conteúdo real, o tamanho e o limite; serve com cabeçalhos seguros", async () => {
    const w = await world("6");
    const id = (await open(w.admin, w.unitId)).body.id;
    const url = `/api/maintenance/${id}/photos`;

    assert.equal((await upload(w.admin, url, Buffer.from("isto não é imagem"), "image/jpeg")).status, 400, "texto com content-type de imagem");
    assert.equal((await upload(w.admin, url, JPEG, "application/pdf")).status, 400, "tipo não aceito");
    assert.equal((await upload(w.admin, url, Buffer.alloc(0), "image/jpeg")).status, 400);
    assert.equal((await upload(w.admin, url, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3 * 1024 * 1024 + 10)]), "image/jpeg")).status, 413);

    const ok = await upload(w.admin, url, PNG, "image/jpeg"); // o tipo vem do conteúdo, não do cabeçalho
    assert.equal(ok.status, 201);
    const got = await download(w.admin, `/api/photos/${ok.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.type, "image/png");
    assert.deepEqual(got.bytes, PNG);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.match(got.headers.get("cache-control") ?? "", /private/);

    for (let i = 0; i < 9; i++) assert.equal((await upload(w.admin, url, JPEG)).status, 201);
    assert.equal((await upload(w.admin, url, JPEG)).status, 409, "limite de 10 fotos");
    assert.equal((await download(new Client(base), `/api/photos/${ok.body.id}`)).status, 401);
  });

  it("não entrega foto a outra organização e a equipe pode remover", async () => {
    const a = await world("7");
    const b = await world("8");
    const id = (await open(a.admin, a.unitId)).body.id;
    const photo = (await upload(a.admin, `/api/maintenance/${id}/photos`, JPEG)).body.id;
    assert.equal((await download(b.admin, `/api/photos/${photo}`)).status, 404);
    assert.equal((await b.admin.call("DELETE", `/api/photos/${photo}`)).status, 404);
    assert.equal((await a.admin.call("DELETE", `/api/photos/${photo}`)).status, 204);
    assert.equal((await download(a.admin, `/api/photos/${photo}`)).status, 404);
    assert.equal((await download(a.admin, "/api/photos/abc")).status, 404);
  });
});

describe("manutenção — área do cliente", () => {
  it("inquilino abre, comenta, anexa e cancela; vê só a linha do tempo pública", async () => {
    const w = await world("9");
    const t = await memberClient(w.admin, "m9t@x.com", "inquilino", { tenantId: w.tenantId });

    assert.equal((await t.call("POST", "/api/portal/tenant/maintenance", { lease_id: w.leaseId, category: "eletrica", title: "x", description: "y", priority: "urgente" })).status, 400, "urgente é da equipe");
    const created = await t.call("POST", "/api/portal/tenant/maintenance", {
      lease_id: w.leaseId, category: "eletrica", title: "Tomada sem energia", description: "Quarto principal", priority: "alta",
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    assert.equal((await t.call("POST", `/api/portal/tenant/maintenance/${id}/comments`, { message: "Ainda sem luz" })).status, 201);
    const photo = await upload(t, `/api/portal/tenant/maintenance/${id}/photos`, JPEG);
    assert.equal(photo.status, 201);
    assert.equal((await download(t, `/api/photos/${photo.body.id}`)).status, 200, "vê a própria foto");

    // A equipe registra nota interna + orçamento; nada disso aparece para o inquilino.
    await w.admin.call("POST", `/api/maintenance/${id}/comments`, { message: "NOTA INTERNA secreta" });
    await status(w.admin, id, "em_analise");
    await w.admin.call("POST", `/api/maintenance/${id}/quotes`, { supplier: "Fornecedor Caro", amount_cents: 99999 });
    await w.admin.call("POST", `/api/maintenance/${id}/comments`, { message: "Eletricista vai na terça", client_visible: true });

    const d = (await t.call("GET", `/api/portal/tenant/maintenance/${id}`)).body;
    const all = JSON.stringify(d);
    assert.doesNotMatch(all, /NOTA INTERNA|Fornecedor Caro|99999|amount_cents|cost_cents/);
    assert.match(all, /Eletricista vai na terça/);
    assert.match(all, /Ainda sem luz/);
    assert.deepEqual(d.photos, [photo.body.id]);
    assert.equal(d.item.status, "aguardando_aprovacao");

    // Só cancela enquanto está aberta.
    assert.equal((await t.call("POST", `/api/portal/tenant/maintenance/${id}/cancel`, {})).status, 409);
    const second = (await t.call("POST", "/api/portal/tenant/maintenance", { lease_id: w.leaseId, category: "outro", title: "Teste", description: "d" })).body.id;
    assert.equal((await t.call("POST", `/api/portal/tenant/maintenance/${second}/cancel`, { reason: "Engano" })).status, 204);
    assert.equal((await t.call("POST", `/api/portal/tenant/maintenance/${second}/comments`, { message: "oi" })).status, 409, "encerrado");
    assert.equal((await t.call("GET", "/api/portal/tenant/maintenance")).body.items.length, 2);
  });

  it("inquilino não mexe no chamado de outro nem em contrato alheio", async () => {
    const w = await world("10");
    const other = (await w.admin.call("POST", "/api/tenants", { name: "Vizinho", document: "555" })).body.item;
    const unit2 = (await w.admin.call("POST", "/api/units", { property_id: (await w.admin.call("GET", "/api/properties")).body.items[0].id, identifier: "U2" })).body.item;
    const lease2 = (await w.admin.call("POST", "/api/leases", { unit_id: unit2.id, tenantIds: [other.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 50000, due_day: 5 })).body.lease;
    await w.admin.call("POST", `/api/leases/${lease2.id}/status`, { status: "vigente" });

    const mine = await memberClient(w.admin, "m10a@x.com", "inquilino", { tenantId: w.tenantId });
    const neighbour = await memberClient(w.admin, "m10b@x.com", "inquilino", { tenantId: other.id });
    const id = (await mine.call("POST", "/api/portal/tenant/maintenance", { lease_id: w.leaseId, category: "outro", title: "Meu", description: "d" })).body.id;
    const photo = (await upload(mine, `/api/portal/tenant/maintenance/${id}/photos`, JPEG)).body.id;

    assert.equal((await neighbour.call("GET", `/api/portal/tenant/maintenance/${id}`)).status, 404);
    assert.equal((await neighbour.call("POST", `/api/portal/tenant/maintenance/${id}/comments`, { message: "oi" })).status, 404);
    assert.equal((await neighbour.call("POST", `/api/portal/tenant/maintenance/${id}/cancel`, {})).status, 404);
    assert.equal((await upload(neighbour, `/api/portal/tenant/maintenance/${id}/photos`, JPEG)).status, 404);
    assert.equal((await download(neighbour, `/api/photos/${photo}`)).status, 404);
    assert.equal((await neighbour.call("POST", "/api/portal/tenant/maintenance", { lease_id: w.leaseId, category: "outro", title: "x", description: "d" })).status, 400, "contrato de outra pessoa");
    assert.equal((await neighbour.call("GET", "/api/portal/tenant/maintenance")).body.items.length, 0);
    assert.equal((await mine.call("GET", "/api/maintenance")).status, 403, "sem acesso ao painel da equipe");
  });

  it("limita a abertura de chamados por inquilino", async () => {
    const w = await world("11");
    const t = await memberClient(w.admin, "m11t@x.com", "inquilino", { tenantId: w.tenantId });
    const body = { lease_id: w.leaseId, category: "outro", title: "Spam", description: "d" };
    for (let i = 0; i < 10; i++) assert.equal((await t.call("POST", "/api/portal/tenant/maintenance", body)).status, 201);
    assert.equal((await t.call("POST", "/api/portal/tenant/maintenance", body)).status, 429);
  });

  it("proprietário acompanha os chamados dos imóveis dele; custo só depois de concluído", async () => {
    const w = await world("12");
    const stranger = await world("13");
    const owner = await memberClient(w.admin, "m12o@x.com", "proprietario", { ownerId: w.ownerId });
    const foreign = await memberClient(stranger.admin, "m13o@x.com", "proprietario", { ownerId: stranger.ownerId });

    const id = (await open(w.admin, w.unitId, { title: "Torneira" })).body.id;
    await status(w.admin, id, "em_analise");
    await status(w.admin, id, "em_execucao");
    let list = (await owner.call("GET", "/api/portal/owner/maintenance")).body.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].cost_cents, null, "custo oculto até concluir");
    await status(w.admin, id, "concluida", { cost_cents: 12000 });
    list = (await owner.call("GET", "/api/portal/owner/maintenance")).body.items;
    assert.equal(list[0].cost_cents, 12000);
    assert.equal((await foreign.call("GET", "/api/portal/owner/maintenance")).body.items.length, 0);

    // Proprietário vê a foto do chamado do imóvel dele; o de outra organização, não.
    const photo = (await upload(w.admin, `/api/maintenance/${(await open(w.admin, w.unitId)).body.id}/photos`, JPEG)).body.id;
    assert.equal((await download(owner, `/api/photos/${photo}`)).status, 200);
    assert.equal((await download(foreign, `/api/photos/${photo}`)).status, 404);
  });
});
