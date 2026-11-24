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

/** Organização com dois contratos vigentes (duas unidades) e um inquilino com acesso a cada um. */
async function world(email: string) {
  const admin = await register(base, email, email);
  const property = (await admin.call("POST", "/api/properties", { name: "Prédio", type: "apartamento" })).body.item;
  const mk = async (i: number) => {
    const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: `Apto ${i}` })).body.item;
    const tenant = (await admin.call("POST", "/api/tenants", { name: `Locatário ${i}`, document: `1234567890${i}` })).body.item;
    const lease = (await admin.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
    assert.equal((await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
    const client = await memberClient(admin, `inq${i}-${email}`, "inquilino", { tenantId: tenant.id });
    return { unitId: unit.id as number, leaseId: lease.id as number, tenantId: tenant.id as number, client };
  };
  const one = await mk(1);
  const two = await mk(2);
  const staff = await memberClient(admin, `col-${email}`, "colaborador");
  return { admin, staff, one, two };
}

describe("moradores", () => {
  it("equipe cadastra, edita, dá baixa na saída; telefone e documento vêm formatados; titulares aparecem à parte", async () => {
    const w = await world("mor1@x.com");
    const r = await w.staff.call("POST", "/api/residents", { lease_id: w.one.leaseId, name: "Ana Souza", relationship: "conjuge", phone: "11912345678", document: "52998224725", birth_date: "1992-03-10" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.item.phone, "(11) 91234-5678");
    assert.equal(r.body.item.document, "529.982.247-25");
    assert.equal(r.body.item.unit_identifier, "Apto 1");

    const bad = (b: Record<string, unknown>) => w.staff.call("POST", "/api/residents", { lease_id: w.one.leaseId, name: "X Y", relationship: "filho", ...b });
    assert.equal((await bad({ relationship: "amigo-imaginario" })).status, 400);
    assert.equal((await bad({ name: "" })).status, 400);
    assert.equal((await bad({ phone: "12" })).status, 400);
    assert.equal((await bad({ birth_date: "2999-01-01" })).status, 400);
    assert.equal((await bad({ email: "nao-e-email" })).status, 400);
    assert.equal((await w.staff.call("POST", "/api/residents", { lease_id: 999999, name: "A B", relationship: "filho" })).status, 400);

    const child = (await bad({ name: "Pedro Souza", relationship: "filho", birth_date: "2015-01-01" })).body.item;
    const list = await w.staff.call("GET", `/api/residents?lease_id=${w.one.leaseId}`);
    assert.equal(list.body.items.length, 2);
    assert.deepEqual(list.body.holders.map((h: { name: string }) => h.name), ["Locatário 1"]);
    assert.equal((await w.staff.call("GET", "/api/residents")).body.holders.length, 2, "todos os contratos vigentes");

    const edit = await w.staff.call("PUT", `/api/residents/${child.id}`, { relationship: "enteado-nao-existe" });
    assert.equal(edit.status, 400);
    assert.equal((await w.staff.call("PUT", `/api/residents/${child.id}`, { notes: "Estuda à tarde" })).body.item.notes, "Estuda à tarde");

    assert.equal((await w.staff.call("POST", `/api/residents/${child.id}/move-out`, { date: inDays(1) })).status, 400, "saída no futuro");
    const out = await w.staff.call("POST", `/api/residents/${child.id}/move-out`, {});
    assert.equal(out.status, 200);
    assert.equal(out.body.item.moved_out_at, today);
    assert.equal((await w.staff.call("POST", `/api/residents/${child.id}/move-out`, {})).status, 409);
    assert.equal((await w.staff.call("PUT", `/api/residents/${child.id}`, { notes: "x" })).status, 409);
    assert.equal((await w.staff.call("GET", `/api/residents?lease_id=${w.one.leaseId}`)).body.items.length, 1, "quem saiu some da lista ativa");
    assert.equal((await w.staff.call("GET", `/api/residents?lease_id=${w.one.leaseId}&scope=todos`)).body.items.length, 2);

    assert.equal((await w.staff.call("DELETE", `/api/residents/${child.id}`)).status, 403, "só admin exclui");
    assert.equal((await w.admin.call("DELETE", `/api/residents/${child.id}`)).status, 204);
  });

  it("inquilino cuida só do próprio contrato e não vê documento dos titulares", async () => {
    const w = await world("mor2@x.com");
    const mine = await w.one.client.call("POST", "/api/portal/tenant/residents", { lease_id: w.one.leaseId, name: "Beatriz Lima", relationship: "filho" });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal((await w.one.client.call("POST", "/api/portal/tenant/residents", { lease_id: w.two.leaseId, name: "Intruso", relationship: "parente" })).status, 400, "contrato do vizinho");

    const list = await w.one.client.call("GET", "/api/portal/tenant/residents");
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.holders[0].document, null);
    assert.equal((await w.two.client.call("GET", "/api/portal/tenant/residents")).body.items.length, 0, "vizinho não vê");

    const id = mine.body.item.id;
    assert.equal((await w.two.client.call("PUT", `/api/portal/tenant/residents/${id}`, { notes: "invadindo" })).status, 404);
    assert.equal((await w.two.client.call("POST", `/api/portal/tenant/residents/${id}/move-out`, {})).status, 404);
    assert.equal((await w.one.client.call("PUT", `/api/portal/tenant/residents/${id}`, { name: "Beatriz L. Lima" })).body.item.name, "Beatriz L. Lima");
    assert.equal((await w.one.client.call("POST", `/api/portal/tenant/residents/${id}/move-out`, {})).status, 200);

    // Inquilino não usa as rotas da equipe.
    assert.equal((await w.one.client.call("GET", "/api/residents")).status, 403);
    assert.equal((await w.one.client.call("POST", "/api/residents", { lease_id: w.one.leaseId, name: "A B", relationship: "filho" })).status, 403);
  });

  it("contrato encerrado não aceita morador novo; limite por contrato", async () => {
    const w = await world("mor3@x.com");
    for (let i = 0; i < 30; i++) {
      assert.equal((await w.staff.call("POST", "/api/residents", { lease_id: w.one.leaseId, name: `Morador ${i}`, relationship: "outro" })).status, 201);
    }
    const over = await w.staff.call("POST", "/api/residents", { lease_id: w.one.leaseId, name: "Morador 31", relationship: "outro" });
    assert.equal(over.status, 409);
    assert.equal((await w.admin.call("POST", `/api/leases/${w.two.leaseId}/status`, { status: "encerrado" })).status, 200);
    assert.equal((await w.staff.call("POST", "/api/residents", { lease_id: w.two.leaseId, name: "Tarde Demais", relationship: "filho" })).status, 409);
    assert.equal((await w.two.client.call("POST", "/api/portal/tenant/residents", { lease_id: w.two.leaseId, name: "Tarde Demais", relationship: "filho" })).status, 409);
  });
});

describe("visitantes e portaria", () => {
  it("autorização com código, entrada e saída conferidas; o inquilino é avisado da chegada", async () => {
    const w = await world("vis1@x.com");
    const created = await w.one.client.call("POST", "/api/portal/tenant/visitors", { lease_id: w.one.leaseId, name: "Tio Carlos", category: "familiar", phone: "11999998888", vehicle_plate: "abc-1d23", notes: "Vem de carro" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const v = created.body.item;
    assert.match(v.access_code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(v.phase, "valido");
    assert.equal(v.vehicle_plate, "ABC1D23");
    assert.equal(v.unit_identifier, "Apto 1");
    assert.equal(v.inside, false);

    // Portaria localiza pelo código e registra a entrada.
    const found = await w.staff.call("GET", `/api/visitors?q=${v.access_code.toLowerCase()}`);
    assert.equal(found.body.items.length, 1);
    const entry = await w.staff.call("POST", `/api/visitors/${v.id}/entry`, { note: "Documento conferido" });
    assert.equal(entry.status, 200, JSON.stringify(entry.body));
    assert.equal(entry.body.item.inside, true);
    assert.equal((await w.staff.call("POST", `/api/visitors/${v.id}/entry`, {})).status, 409, "já está dentro");
    assert.equal((await w.staff.call("POST", `/api/visitors/${v.id}/cancel`)).status, 409, "dentro: sem cancelar");
    assert.equal((await w.staff.call("GET", "/api/visitors?inside=1")).body.items.length, 1);

    const notes = await w.one.client.call("GET", "/api/notifications");
    assert.ok(JSON.stringify(notes.body).includes("Tio Carlos chegou"), "inquilino foi avisado");
    assert.ok(!JSON.stringify((await w.two.client.call("GET", "/api/notifications")).body).includes("Tio Carlos"), "o vizinho não");

    const exit = await w.staff.call("POST", `/api/visitors/${v.id}/exit`, {});
    assert.equal(exit.body.item.inside, false);
    assert.equal((await w.staff.call("POST", `/api/visitors/${v.id}/exit`, {})).status, 409, "já saiu");

    const events = await w.one.client.call("GET", `/api/portal/tenant/visitors/${v.id}/events`);
    assert.deepEqual(events.body.items.map((e: { event: string }) => e.event), ["saida", "entrada"]);
    assert.equal((await w.two.client.call("GET", `/api/portal/tenant/visitors/${v.id}/events`)).status, 404);

    const log = await w.staff.call("GET", "/api/access/log");
    assert.equal(log.body.items.length, 2);
    assert.equal((await w.staff.call("GET", "/api/access/log?date=2026-13-40")).status, 400);

    // Auditoria e permissão.
    assert.match(JSON.stringify((await w.admin.call("GET", "/api/audit")).body), /Registrou entrada de visitante/);
    assert.equal((await w.one.client.call("POST", `/api/visitors/${v.id}/entry`, {})).status, 403, "inquilino não opera a portaria");
  });

  it("validade: agendado não entra antes; vencido não entra; bloqueado e cancelado não entram", async () => {
    const w = await world("vis2@x.com");
    const mk = async (extra: Record<string, unknown>) => (await w.staff.call("POST", "/api/visitors", { unit_id: w.one.unitId, name: "Fulano Teste", ...extra })).body.item;
    const future = await mk({ valid_from: inDays(3), valid_until: inDays(3) });
    assert.equal(future.phase, "agendado");
    const r = await w.staff.call("POST", `/api/visitors/${future.id}/entry`, {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Fora da validade/);

    const blocked = await mk({});
    assert.equal((await w.staff.call("POST", `/api/visitors/${blocked.id}/block`, { note: "Não autorizado pelo morador" })).body.item.status, "bloqueado");
    const b = await w.staff.call("POST", `/api/visitors/${blocked.id}/entry`, {});
    assert.equal(b.status, 409);
    assert.match(b.body.error, /BLOQUEADO/);
    assert.equal((await w.one.client.call("POST", `/api/portal/tenant/visitors/${blocked.id}/cancel`)).status, 409, "inquilino não desfaz bloqueio da portaria");
    assert.equal((await w.staff.call("POST", `/api/visitors/${blocked.id}/unblock`)).body.item.status, "autorizado");
    assert.equal((await w.staff.call("POST", `/api/visitors/${blocked.id}/entry`, {})).status, 200);

    const cancelled = await mk({});
    assert.equal((await w.one.client.call("POST", `/api/portal/tenant/visitors/${cancelled.id}/cancel`)).body.item.status, "cancelado");
    assert.equal((await w.staff.call("POST", `/api/visitors/${cancelled.id}/entry`, {})).status, 409);
    assert.equal((await w.one.client.call("PUT", `/api/portal/tenant/visitors/${cancelled.id}`, { name: "Outro Nome" })).status, 409);
  });

  it("recorrente (prestador por semanas) entra e sai várias vezes; datas inválidas são recusadas", async () => {
    const w = await world("vis3@x.com");
    const base = { lease_id: w.one.leaseId, name: "Diarista Rosa", category: "prestador" };
    const post = (b: Record<string, unknown>) => w.one.client.call("POST", "/api/portal/tenant/visitors", { ...base, ...b });
    assert.equal((await post({ valid_from: inDays(-1) })).status, 400, "início no passado");
    assert.equal((await post({ valid_from: inDays(5), valid_until: inDays(2) })).status, 400, "fim antes do início");
    assert.equal((await post({ valid_until: inDays(400) })).status, 400, "mais de 1 ano");
    assert.equal((await post({ category: "alienigena" })).status, 400);
    assert.equal((await post({ vehicle_plate: "!!" })).status, 400);
    assert.equal((await post({ name: "" })).status, 400);
    assert.equal((await post({ lease_id: w.two.leaseId })).status, 400, "unidade do vizinho");

    const rec = (await post({ valid_until: inDays(30) })).body.item;
    for (let i = 0; i < 3; i++) {
      assert.equal((await w.staff.call("POST", `/api/visitors/${rec.id}/entry`, {})).status, 200);
      assert.equal((await w.staff.call("POST", `/api/visitors/${rec.id}/exit`, {})).status, 200);
    }
    assert.equal((await w.staff.call("GET", `/api/visitors/${rec.id}/events`)).body.items.length, 6);

    // Inquilino ajusta a validade e vê só o que é da sua unidade.
    const upd = await w.one.client.call("PUT", `/api/portal/tenant/visitors/${rec.id}`, { valid_until: inDays(60) });
    assert.equal(upd.status, 200);
    assert.equal(String(upd.body.item.valid_until).slice(0, 10), inDays(60));
    assert.equal((await w.one.client.call("GET", "/api/portal/tenant/visitors")).body.items.length, 1);
    assert.equal((await w.two.client.call("GET", "/api/portal/tenant/visitors")).body.items.length, 0);
    assert.equal((await w.two.client.call("PUT", `/api/portal/tenant/visitors/${rec.id}`, { name: "Invasor Total" })).status, 404);
  });

  it("isolamento entre organizações e acesso anônimo", async () => {
    const w = await world("vis4@x.com");
    const other = await world("vis4b@x.com");
    const v = (await w.staff.call("POST", "/api/visitors", { unit_id: w.one.unitId, name: "Visita Privada" })).body.item;
    assert.equal((await other.staff.call("POST", `/api/visitors/${v.id}/entry`, {})).status, 404);
    assert.equal((await other.staff.call("POST", "/api/visitors", { unit_id: w.one.unitId, name: "Invasor Total" })).status, 400, "unidade de outra organização");
    assert.equal((await other.staff.call("GET", "/api/visitors")).body.items.length, 0);
    assert.equal((await new Client(base).call("GET", "/api/visitors")).status, 401);
    const ownerRec = (await w.admin.call("POST", "/api/owners", { name: "Dono Vis", document: "98765432100" })).body.item;
    const owner = await memberClient(w.admin, "dono-vis4@x.com", "proprietario", { ownerId: ownerRec.id });
    assert.equal((await owner.call("GET", "/api/visitors")).status, 403);
  });
});
