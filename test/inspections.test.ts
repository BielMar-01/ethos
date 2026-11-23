import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, JPEG, download, register, startServer, upload } from "./helpers.js";

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
  propertyId: number;
  unitId: number;
  tenantId: number;
  leaseId: number;
}

async function world(tag: string): Promise<W> {
  const admin = await register(base, `i${tag}@x.com`, `Insp ${tag}`);
  const owner = (await admin.call("POST", "/api/owners", { name: `Dono ${tag}`, document: `1${tag}` })).body.item;
  const property = (await admin.call("POST", "/api/properties", { name: `Imóvel ${tag}`, type: "casa", street: "Rua A", number: "10", city: "São Paulo", state: "SP" })).body.item;
  await admin.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: `U${tag}` })).body.item;
  const tenant = (await admin.call("POST", "/api/tenants", { name: `Inquilino ${tag}`, document: `2${tag}` })).body.item;
  const lease = (
    await admin.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })
  ).body.lease;
  await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  return { admin, ownerId: owner.id, propertyId: property.id, unitId: unit.id, tenantId: tenant.id, leaseId: lease.id };
}

const create = (c: Client, unitId: number, extra: Record<string, unknown> = {}) =>
  c.call("POST", "/api/inspections", { unit_id: unitId, type: "entrada", scheduled_for: "2024-05-10", ...extra });
const detail = async (c: Client, id: number) => (await c.call("GET", `/api/inspections/${id}`)).body;

/** Avalia todos os itens ainda sem avaliação. */
async function evaluateAll(c: Client, id: number, condition = "bom") {
  for (const it of (await detail(c, id)).items) {
    if (!it.condition) assert.equal((await c.call("PATCH", `/api/inspections/${id}/items/${it.id}`, { condition })).status, 204);
  }
}

describe("vistorias — equipe", () => {
  it("cria com checklist padrão, liga ao contrato vigente e valida", async () => {
    const w = await world("1");
    const r = await create(w.admin, w.unitId, { notes: "Entrega das chaves" });
    assert.equal(r.status, 201);
    const d = await detail(w.admin, r.body.id);
    assert.equal(d.inspection.status, "agendada");
    assert.equal(d.inspection.lease_id, w.leaseId);
    assert.ok(d.items.length >= 25);
    assert.ok(d.items.every((i: { condition: unknown }) => i.condition === null));
    assert.deepEqual(d.items[0].room, "Sala");

    const bare = await create(w.admin, w.unitId, { useDefaultChecklist: false });
    assert.equal((await detail(w.admin, bare.body.id)).items.length, 0);

    assert.equal((await create(w.admin, w.unitId, { type: "festa" })).status, 400);
    assert.equal((await create(w.admin, w.unitId, { scheduled_for: "2024-02-31" })).status, 400);
    assert.equal((await create(w.admin, 999999)).status, 400);
    assert.equal((await create(w.admin, w.unitId, { lease_id: 999999 })).status, 400);
  });

  it("só conclui com todos os itens avaliados; depois de concluída, é imutável", async () => {
    const w = await world("2");
    const id = (await create(w.admin, w.unitId)).body.id;
    const conclude = (extra: Record<string, unknown> = {}) => w.admin.call("POST", `/api/inspections/${id}/status`, { status: "concluida", ...extra });

    assert.equal((await conclude()).status, 409, "ainda agendada");
    assert.equal((await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" })).status, 200);
    const blocked = await conclude();
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /sem avaliação/);

    // Item novo, duplicado e removido.
    const added = await w.admin.call("POST", `/api/inspections/${id}/items`, { room: "Varanda", item: "Guarda-corpo" });
    assert.equal(added.status, 201);
    assert.equal((await w.admin.call("POST", `/api/inspections/${id}/items`, { room: "Varanda", item: "Guarda-corpo" })).status, 409);
    assert.equal((await w.admin.call("PATCH", `/api/inspections/${id}/items/${added.body.id}`, { condition: "ótimo" })).status, 400);
    assert.equal((await w.admin.call("DELETE", `/api/inspections/${id}/items/${added.body.id}`)).status, 204);

    const first = (await detail(w.admin, id)).items[0];
    const photo = (await upload(w.admin, `/api/inspections/${id}/items/${first.id}/photos`, JPEG)).body.id;
    await evaluateAll(w.admin, id, "regular");
    assert.equal((await conclude({ performed_at: "2999-01-01" })).status, 400);
    assert.equal((await conclude({ performed_at: "2024-05-11" })).status, 200);

    const d = await detail(w.admin, id);
    assert.equal(d.inspection.status, "concluida");
    assert.equal(d.inspection.performed_at, "2024-05-11");
    assert.deepEqual(d.items[0].photos, [photo]);

    // Imutável: nada de editar, adicionar, remover, anexar ou reabrir.
    assert.equal((await w.admin.call("PATCH", `/api/inspections/${id}/items/${first.id}`, { condition: "novo" })).status, 409);
    assert.equal((await w.admin.call("POST", `/api/inspections/${id}/items`, { room: "X", item: "Y" })).status, 409);
    assert.equal((await w.admin.call("DELETE", `/api/inspections/${id}/items/${first.id}`)).status, 409);
    assert.equal((await w.admin.call("PATCH", `/api/inspections/${id}`, { notes: "mudei" })).status, 409);
    assert.equal((await upload(w.admin, `/api/inspections/${id}/items/${first.id}/photos`, JPEG)).status, 409);
    assert.equal((await w.admin.call("DELETE", `/api/photos/${photo}`)).status, 409);
    assert.equal((await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" })).status, 409);
    assert.equal((await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "cancelada" })).status, 409);
  });

  it("não conclui vistoria sem itens e permite cancelar antes de concluir", async () => {
    const w = await world("3");
    const empty = (await create(w.admin, w.unitId, { useDefaultChecklist: false })).body.id;
    await w.admin.call("POST", `/api/inspections/${empty}/status`, { status: "em_andamento" });
    assert.equal((await w.admin.call("POST", `/api/inspections/${empty}/status`, { status: "concluida" })).status, 409);
    assert.equal((await w.admin.call("POST", `/api/inspections/${empty}/status`, { status: "cancelada" })).status, 200);
    assert.equal((await w.admin.call("POST", `/api/inspections/${empty}/status`, { status: "zzz" })).status, 400);
  });

  it("registra ciência (uma por papel, só após concluir) e gera o laudo", async () => {
    const w = await world("4");
    const id = (await create(w.admin, w.unitId, { notes: "Imóvel pintado há 1 mês" })).body.id;
    const sign = (role: string, name = "Fulano de Tal") => w.admin.call("POST", `/api/inspections/${id}/signatures`, { role, signer_name: name });

    assert.equal((await sign("vistoriador")).status, 409, "ainda não concluída");
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" });
    const items = (await detail(w.admin, id)).items;
    await w.admin.call("PATCH", `/api/inspections/${id}/items/${items[0].id}`, { condition: "ruim", notes: "Mancha de umidade" });
    await evaluateAll(w.admin, id, "bom");
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "concluida", performed_at: "2024-05-12" });

    assert.equal((await sign("vistoriador", "Ana Vistoriadora")).status, 201);
    assert.equal((await sign("vistoriador")).status, 409, "uma por papel");
    assert.equal((await sign("locatario", "Inquilino 4")).status, 201);
    assert.equal((await sign("testemunha")).status, 400);
    assert.equal((await sign("locatario", " ")).status, 400);

    const { report } = (await w.admin.call("GET", `/api/inspections/${id}/report`)).body;
    assert.match(report, /LAUDO DE VISTORIA DE ENTRADA/);
    assert.match(report, /Imóvel: Imóvel 4 — unidade U4/);
    assert.match(report, /Endereço: Rua A, 10, São Paulo\/SP/);
    assert.match(report, /Data da vistoria: 12\/05\/2024/);
    assert.match(report, /Locatário\(s\): Inquilino 4/);
    assert.match(report, /Observações gerais: Imóvel pintado há 1 mês/);
    assert.match(report, /SALA\n {2}• Paredes: Ruim — Mancha de umidade/);
    assert.match(report, /Vistoriador: Ana Vistoriadora/);
    assert.match(report, /Locatário: Inquilino 4/);
  });

  it("compara entrada × saída apontando o que piorou", async () => {
    const w = await world("5");
    const run = async (type: string, conditionFor: (room: string, item: string) => string) => {
      const id = (await create(w.admin, w.unitId, { type })).body.id;
      await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" });
      for (const it of (await detail(w.admin, id)).items) {
        await w.admin.call("PATCH", `/api/inspections/${id}/items/${it.id}`, { condition: conditionFor(it.room, it.item) });
      }
      assert.equal((await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "concluida" })).status, 200);
      return id as number;
    };
    const entry = await run("entrada", () => "bom");
    const exit = await run("saida", (room, item) => (room === "Sala" && item === "Paredes" ? "danificado" : room === "Cozinha" && item === "Piso" ? "novo" : "bom"));

    const cmp = (await w.admin.call("GET", `/api/inspections/${entry}/compare/${exit}`)).body;
    assert.equal(cmp.summary.piorou, 1);
    assert.equal(cmp.summary.melhorou, 1);
    assert.ok(cmp.summary.igual > 20);
    const worse = cmp.items.find((i: { change: string }) => i.change === "piorou");
    assert.deepEqual([worse.room, worse.item, worse.first.condition, worse.second.condition], ["Sala", "Paredes", "bom", "danificado"]);

    // Comparação exige concluídas e da mesma unidade.
    const open = (await create(w.admin, w.unitId)).body.id;
    assert.equal((await w.admin.call("GET", `/api/inspections/${entry}/compare/${open}`)).status, 409);
    const other = await world("6");
    const foreignUnit = (await other.admin.call("GET", "/api/units")).body.items[0].id;
    const otherInsp = (await create(other.admin, foreignUnit)).body.id;
    assert.equal((await w.admin.call("GET", `/api/inspections/${entry}/compare/${otherInsp}`)).status, 404, "outra organização");
  });

  it("isola vistorias entre organizações", async () => {
    const a = await world("7");
    const b = await world("8");
    const id = (await create(a.admin, a.unitId)).body.id;
    const item = (await detail(a.admin, id)).items[0].id;
    assert.equal((await b.admin.call("GET", "/api/inspections")).body.items.length, 0);
    assert.equal((await b.admin.call("GET", `/api/inspections/${id}`)).status, 404);
    assert.equal((await b.admin.call("PATCH", `/api/inspections/${id}/items/${item}`, { condition: "bom" })).status, 404);
    assert.equal((await b.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" })).status, 404);
    assert.equal((await b.admin.call("GET", `/api/inspections/${id}/report`)).status, 404);
    assert.equal((await upload(b.admin, `/api/inspections/${id}/items/${item}/photos`, JPEG)).status, 404);
    assert.equal((await create(b.admin, a.unitId)).status, 400);
  });
});

describe("vistorias — área do cliente", () => {
  it("inquilino vê só vistorias concluídas do contrato dele, lê o laudo e confirma ciência", async () => {
    const w = await world("9");
    const t = await memberClient(w.admin, "i9t@x.com", "inquilino", { tenantId: w.tenantId });
    const id = (await create(w.admin, w.unitId)).body.id;
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" });
    const first = (await detail(w.admin, id)).items[0];
    const photo = (await upload(w.admin, `/api/inspections/${id}/items/${first.id}/photos`, JPEG)).body.id;

    // Enquanto não conclui, nada aparece (nem a foto).
    assert.equal((await t.call("GET", "/api/portal/tenant/inspections")).body.items.length, 0);
    assert.equal((await t.call("GET", `/api/portal/tenant/inspections/${id}`)).status, 404);
    assert.equal((await download(t, `/api/photos/${photo}`)).status, 404);

    await evaluateAll(w.admin, id);
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "concluida" });

    assert.equal((await t.call("GET", "/api/portal/tenant/inspections")).body.items.length, 1);
    const d = (await t.call("GET", `/api/portal/tenant/inspections/${id}`)).body;
    assert.match(d.report, /LAUDO DE VISTORIA DE ENTRADA/);
    assert.equal(d.signatures.length, 0);
    assert.equal((await download(t, `/api/photos/${photo}`)).status, 200);

    assert.equal((await t.call("POST", `/api/portal/tenant/inspections/${id}/sign`, { signer_name: " " })).status, 400);
    assert.equal((await t.call("POST", `/api/portal/tenant/inspections/${id}/sign`, { signer_name: "Inquilino 9" })).status, 201);
    assert.equal((await t.call("POST", `/api/portal/tenant/inspections/${id}/sign`, { signer_name: "Inquilino 9" })).status, 409);
    const signed = (await t.call("GET", `/api/portal/tenant/inspections/${id}`)).body;
    assert.deepEqual(signed.signatures.map((s: { role: string }) => s.role), ["locatario"]);
  });

  it("outro inquilino e outro proprietário não enxergam; o proprietário do imóvel sim", async () => {
    const w = await world("10");
    const neighbour = (await w.admin.call("POST", "/api/tenants", { name: "Vizinho", document: "777" })).body.item;
    const mine = await memberClient(w.admin, "i10a@x.com", "inquilino", { tenantId: w.tenantId });
    const other = await memberClient(w.admin, "i10b@x.com", "inquilino", { tenantId: neighbour.id });
    const owner = await memberClient(w.admin, "i10o@x.com", "proprietario", { ownerId: w.ownerId });
    const stranger = (await w.admin.call("POST", "/api/owners", { name: "Outro Dono", document: "888" })).body.item;
    const otherOwner = await memberClient(w.admin, "i10p@x.com", "proprietario", { ownerId: stranger.id });

    const id = (await create(w.admin, w.unitId)).body.id;
    const first = (await detail(w.admin, id)).items[0];
    const photo = (await upload(w.admin, `/api/inspections/${id}/items/${first.id}/photos`, JPEG)).body.id;
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "em_andamento" });
    await evaluateAll(w.admin, id);
    await w.admin.call("POST", `/api/inspections/${id}/status`, { status: "concluida" });

    assert.equal((await mine.call("GET", `/api/portal/tenant/inspections/${id}`)).status, 200);
    assert.equal((await other.call("GET", `/api/portal/tenant/inspections/${id}`)).status, 404);
    assert.equal((await other.call("POST", `/api/portal/tenant/inspections/${id}/sign`, { signer_name: "Intruso" })).status, 404);
    assert.equal((await download(other, `/api/photos/${photo}`)).status, 404);

    assert.equal((await owner.call("GET", "/api/portal/owner/inspections")).body.items.length, 1);
    assert.equal((await owner.call("GET", `/api/portal/owner/inspections/${id}`)).status, 200);
    assert.equal((await download(owner, `/api/photos/${photo}`)).status, 200);
    assert.equal((await owner.call("POST", `/api/portal/owner/inspections/${id}/sign`, { signer_name: "Dono 10" })).status, 201);
    assert.equal((await otherOwner.call("GET", "/api/portal/owner/inspections")).body.items.length, 0);
    assert.equal((await otherOwner.call("GET", `/api/portal/owner/inspections/${id}`)).status, 404);
    assert.equal((await download(otherOwner, `/api/photos/${photo}`)).status, 404);

    // Cliente nunca usa as rotas da equipe.
    assert.equal((await mine.call("GET", "/api/inspections")).status, 403);
    assert.equal((await mine.call("POST", `/api/inspections/${id}/signatures`, { role: "locatario", signer_name: "x" })).status, 403);
  });
});
