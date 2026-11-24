import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, JPEG, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
const nowHHMM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

async function memberClient(admin: Client, email: string, role: string, extra: Record<string, unknown> = {}): Promise<Client> {
  const inv = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  assert.equal((await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Membro " + email, password: "senha-segura-123" })).status, 201);
  return c;
}

async function world(email: string) {
  const admin = await register(base, email, email);
  const owner = (await admin.call("POST", "/api/owners", { name: "Dono", document: "111" + email.length })).body.item;
  const property = (await admin.call("POST", "/api/properties", { name: "Prédio", type: "apartamento" })).body.item;
  await admin.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: "Apto 1" })).body.item;
  const tenant = (await admin.call("POST", "/api/tenants", { name: "Locatário", document: "222" + email.length })).body.item;
  const lease = (await admin.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
  await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  const tenantClient = await memberClient(admin, `inq-${email}`, "inquilino", { tenantId: tenant.id });
  const ownerClient = await memberClient(admin, `dono-${email}`, "proprietario", { ownerId: owner.id });
  const staff = await memberClient(admin, `col-${email}`, "colaborador");
  const orgId = (await admin.call("GET", "/api/auth/me")).body.organization.id as number;
  return { admin, staff, tenantClient, ownerClient, unitId: unit.id as number, leaseId: lease.id as number, orgId };
}
const authorize = (c: Client, unitId: number, extra: Record<string, unknown> = {}) =>
  c.call("POST", "/api/visitors", { unit_id: unitId, name: "Diarista Maria", category: "prestador", valid_from: today, valid_until: today, ...extra });

describe("visitas recorrentes", () => {
  it("valida dias e horários, bloqueia a entrada fora da janela e permite renovar", async () => {
    const w = await world("rec1@x.com");
    assert.equal((await authorize(w.staff, w.unitId, { weekdays: [9] })).status, 400);
    assert.equal((await authorize(w.staff, w.unitId, { time_from: "08:00" })).status, 400, "falta o horário final");
    assert.equal((await authorize(w.staff, w.unitId, { time_from: "10:00", time_to: "09:00" })).status, 400);
    assert.equal((await authorize(w.staff, w.unitId, { time_from: "8h", time_to: "9h" })).status, 400);
    assert.equal((await authorize(w.staff, w.unitId, { max_stay_minutes: 5 })).status, 400);

    // Outro dia da semana: não entra.
    const other = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dow).slice(0, 2);
    const wrongDay = (await authorize(w.staff, w.unitId, { weekdays: other })).body.item;
    assert.equal(wrongDay.weekdays, other.join(","));
    const no = await w.staff.call("POST", `/api/visitors/${wrongDay.id}/entry`, {});
    assert.equal(no.status, 409);
    assert.match(no.body.error, /não é um dia autorizado/);

    // Dia certo, horário errado.
    const hour = Number(nowHHMM().slice(0, 2));
    const past = hour >= 2 ? { time_from: "00:00", time_to: "00:01" } : { time_from: "23:58", time_to: "23:59" };
    const wrongTime = (await authorize(w.staff, w.unitId, { weekdays: [dow], ...past })).body.item;
    const noTime = await w.staff.call("POST", `/api/visitors/${wrongTime.id}/entry`, {});
    assert.equal(noTime.status, 409);
    assert.match(noTime.body.error, /Fora do horário autorizado/);

    // Dentro da regra: entra.
    const okV = (await authorize(w.staff, w.unitId, { weekdays: [dow], time_from: "00:00", time_to: "23:59", expected_time: "09:00", max_stay_minutes: 120 })).body.item;
    assert.equal(okV.time_from, "00:00");
    assert.equal(okV.expected_time, "09:00");
    assert.equal((await w.staff.call("POST", `/api/visitors/${okV.id}/entry`, {})).status, 200);

    // Renovar: +30 dias por padrão, nunca passa de 365 dias, só ativa; o inquilino renova a sua.
    const r = await w.staff.call("POST", `/api/visitors/${okV.id}/renew`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const expected = new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(String(r.body.item.valid_until).slice(0, 10), expected);
    assert.equal((await w.staff.call("POST", `/api/visitors/${okV.id}/renew`, { valid_until: "2999-01-01" })).status, 400);
    assert.equal((await w.staff.call("POST", `/api/visitors/${okV.id}/renew`, { valid_until: today })).status, 400, "não pode encurtar");
    const mine = (await w.tenantClient.call("POST", "/api/portal/tenant/visitors", { lease_id: w.leaseId, name: "Faxineira Lúcia", valid_from: today, valid_until: today, weekdays: [dow] })).body.item;
    assert.equal((await w.tenantClient.call("POST", `/api/portal/tenant/visitors/${mine.id}/renew`, {})).status, 200);
    const stranger = await world("rec2@x.com");
    assert.equal((await stranger.tenantClient.call("POST", `/api/portal/tenant/visitors/${mine.id}/renew`, {})).status, 404);
    await w.staff.call("POST", `/api/visitors/${wrongDay.id}/cancel`);
    assert.equal((await w.staff.call("POST", `/api/visitors/${wrongDay.id}/renew`, {})).status, 409);
  });
});

describe("avisos automáticos de acesso", () => {
  it("avisa visita que não chegou (1 vez/dia) e permanência acima do limite (1 vez/entrada)", async () => {
    const { runAccessAlerts } = await import("../src/household2.js");
    const { db } = await import("../src/db.js");
    const w = await world("alert1@x.com");
    const titles = async (c: Client) => ((await c.call("GET", "/api/notifications")).body.items as { title: string }[]).map((n) => n.title);

    // Sem hora prevista não há aviso; com hora prevista no passado há um só.
    await authorize(w.staff, w.unitId, { name: "Sem hora" });
    const late = (await authorize(w.staff, w.unitId, { name: "Técnico Carlos", expected_time: "00:00" })).body.item;
    const first = await runAccessAlerts();
    if (nowHHMM() >= "01:00") {
      assert.ok(first.notArrived >= 1);
      assert.ok((await titles(w.tenantClient)).includes("Técnico Carlos ainda não chegou"));
      assert.equal((await runAccessAlerts()).notArrived, 0, "não repete no mesmo dia");
    }

    // Quem já entrou hoje não gera aviso de atraso; permanência acima do limite avisa inquilino e equipe.
    const inside = (await authorize(w.staff, w.unitId, { name: "Pedreiro Zé", expected_time: "00:00", max_stay_minutes: 30 })).body.item;
    assert.equal((await w.staff.call("POST", `/api/visitors/${inside.id}/entry`, {})).status, 200);
    await db.query("UPDATE access_events SET at = now() - interval '90 minutes' WHERE visitor_id = $1", [inside.id]);
    const r = await runAccessAlerts();
    assert.ok(r.overstay >= 2, "inquilino + equipe");
    assert.ok((await titles(w.tenantClient)).includes("Visitante há muito tempo dentro"));
    assert.ok(!(await titles(w.tenantClient)).includes("Pedreiro Zé ainda não chegou"));
    assert.equal((await runAccessAlerts()).overstay, 0, "um aviso por entrada");

    // Saiu: some do alerta. (Nova entrada gera novo evento, novo aviso.)
    await w.staff.call("POST", `/api/visitors/${inside.id}/exit`, {});
    await db.query("UPDATE access_events SET overstay_alerted_at = NULL");
    assert.equal((await runAccessAlerts()).overstay, 0, "quem já saiu não conta");
    assert.ok(late);
  });
});

describe("foto do visitante", () => {
  it("só com consentimento, valida a imagem, aparece à equipe e ao inquilino da unidade; apaga depois do prazo", async () => {
    const { purgeVisitorPhotos } = await import("../src/household2.js");
    const { db } = await import("../src/db.js");
    const w = await world("foto1@x.com");
    const v = (await authorize(w.staff, w.unitId)).body.item;
    const put = (c: Client, q: string, body: Buffer | string = JPEG, type = "image/jpeg") =>
      fetch(`${base}/api/visitors/${v.id}/photo${q}`, { method: "PUT", headers: { "Content-Type": type, Cookie: c.cookie }, body: typeof body === "string" ? body : new Uint8Array(body) });
    assert.equal((await put(w.staff, "")).status, 400, "sem consentimento");
    assert.equal((await put(w.staff, "?consent=1", "isso não é imagem")).status, 400);
    assert.equal((await put(w.staff, "?consent=1", Buffer.concat([JPEG, Buffer.alloc(1.2 * 1024 * 1024)]))).status, 413);
    assert.equal((await put(w.tenantClient, "?consent=1")).status, 403, "inquilino não fotografa");
    assert.equal((await put(w.staff, "?consent=1")).status, 204);

    const item = (await w.staff.call("GET", `/api/visitors?q=${encodeURIComponent("Diarista")}`)).body.items[0];
    assert.equal(item.has_photo, true);
    assert.ok(item.photo_consent_at);
    const get = await fetch(`${base}/api/visitors/${v.id}/photo`, { headers: { Cookie: w.staff.cookie } });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), JPEG);
    assert.equal((await fetch(`${base}/api/portal/tenant/visitors/${v.id}/photo`, { headers: { Cookie: w.tenantClient.cookie } })).status, 200);
    const other = await world("foto2@x.com");
    assert.equal((await fetch(`${base}/api/portal/tenant/visitors/${v.id}/photo`, { headers: { Cookie: other.tenantClient.cookie } })).status, 404, "outra unidade não vê");
    assert.equal((await fetch(`${base}/api/visitors/${v.id}/photo`, { headers: { Cookie: other.staff.cookie } })).status, 404, "outra organização não vê");

    assert.equal(await purgeVisitorPhotos(), 0, "autorização ainda vale");
    await db.query("UPDATE visitors SET valid_from = $2::date - 60, valid_until = $2::date - 40 WHERE id = $1", [v.id, today]);
    assert.equal(await purgeVisitorPhotos(), 1, "30 dias depois do fim a foto é apagada");
    assert.equal((await fetch(`${base}/api/visitors/${v.id}/photo`, { headers: { Cookie: w.staff.cookie } })).status, 404);

    const v2 = (await authorize(w.staff, w.unitId, { name: "Outro" })).body.item;
    await fetch(`${base}/api/visitors/${v2.id}/photo?consent=1`, { method: "PUT", headers: { "Content-Type": "image/jpeg", Cookie: w.staff.cookie }, body: new Uint8Array(JPEG) });
    assert.equal((await w.staff.call("DELETE", `/api/visitors/${v2.id}/photo`)).status, 204);
    assert.equal((await w.staff.call("DELETE", `/api/visitors/${v2.id}/photo`)).status, 404);
  });
});

describe("relatório de acessos", () => {
  it("lista entradas com saída e duração, filtra por período e exporta CSV", async () => {
    const { db } = await import("../src/db.js");
    const w = await world("rel1@x.com");
    const v = (await authorize(w.staff, w.unitId, { name: "Entregador João", category: "entregador", document: "11122233344" })).body.item;
    await w.staff.call("POST", `/api/visitors/${v.id}/entry`, {});
    await db.query("UPDATE access_events SET at = now() - interval '45 minutes' WHERE visitor_id = $1", [v.id]);
    await w.staff.call("POST", `/api/visitors/${v.id}/exit`, {});
    const v2 = (await authorize(w.staff, w.unitId, { name: "Ainda dentro" })).body.item;
    await w.staff.call("POST", `/api/visitors/${v2.id}/entry`, {});

    const rep = (await w.staff.call("GET", `/api/access/report?from=${today}&to=${today}`)).body;
    assert.equal(rep.total, 2);
    assert.equal(rep.still_inside, 1);
    assert.equal(rep.by_category.entregador, 1);
    const done = rep.items.find((i: { name: string }) => i.name === "Entregador João");
    assert.ok(done.minutes >= 44 && done.minutes <= 46);
    assert.equal((await w.staff.call("GET", "/api/access/report?from=2024-01-01&to=2024-01-02")).body.total, 0);
    assert.equal((await w.staff.call("GET", "/api/access/report?from=2020-01-01&to=2024-01-02")).status, 400, "máx. 366 dias");
    const csv = await fetch(`${base}/api/access/report?from=${today}&to=${today}&format=csv`, { headers: { Cookie: w.staff.cookie } });
    const text = Buffer.from(await csv.arrayBuffer()).toString("utf8").replace(/^﻿/, "");
    assert.ok(text.startsWith("Entrada;Saída;Minutos;Visitante"));
    assert.match(text, /Entregador João/);
    assert.equal((await w.tenantClient.call("GET", `/api/access/report?from=${today}&to=${today}`)).status, 403);
  });
});

describe("encomendas", () => {
  it("portaria registra, avisa o inquilino, entrega e devolve; lembrete depois de 3 dias", async () => {
    const { runParcelReminders } = await import("../src/household2.js");
    const { db } = await import("../src/db.js");
    const w = await world("enc1@x.com");
    assert.equal((await w.staff.call("POST", "/api/parcels", { unit_id: w.unitId })).status, 400);
    assert.equal((await w.staff.call("POST", "/api/parcels", { unit_id: 999999, description: "Caixa" })).status, 404);
    const p = await w.staff.call("POST", "/api/parcels", { unit_id: w.unitId, description: "Caixa grande", carrier: "Correios", recipient_name: "Locatário" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.item.status, "recebida");
    const notes = (await w.tenantClient.call("GET", "/api/notifications")).body.items as { category: string; title: string }[];
    assert.ok(notes.some((n) => n.category === "encomenda" && n.title === "Chegou uma encomenda"));

    assert.equal((await w.tenantClient.call("GET", "/api/portal/tenant/parcels")).body.items.length, 1);
    assert.equal((await w.staff.call("GET", "/api/parcels")).body.items.length, 1);
    assert.equal((await w.tenantClient.call("POST", "/api/parcels", { unit_id: w.unitId, description: "x" })).status, 403);

    assert.equal((await runParcelReminders()), 0, "ainda é recente");
    await db.query("UPDATE parcels SET received_at = now() - interval '4 days' WHERE id = $1", [p.body.item.id]);
    assert.equal(await runParcelReminders(), 1);
    assert.equal(await runParcelReminders(), 0, "um lembrete só");

    assert.equal((await w.staff.call("POST", `/api/parcels/${p.body.item.id}/pickup`, {})).status, 400, "quem retirou?");
    const done = await w.staff.call("POST", `/api/parcels/${p.body.item.id}/pickup`, { picked_up_by_name: "Filho do locatário" });
    assert.equal(done.body.item.status, "retirada");
    assert.equal((await w.staff.call("POST", `/api/parcels/${p.body.item.id}/pickup`, { picked_up_by_name: "x" })).status, 409, "já encerrada");
    assert.equal((await w.staff.call("GET", "/api/parcels")).body.items.length, 0, "padrão: só as que aguardam");
    assert.equal((await w.staff.call("GET", "/api/parcels?status=all")).body.items.length, 1);

    const p2 = await w.staff.call("POST", "/api/parcels", { unit_id: w.unitId, description: "Pacote errado" });
    assert.equal((await w.staff.call("POST", `/api/parcels/${p2.body.item.id}/return`, {})).body.item.status, "devolvida");
    const other = await world("enc2@x.com");
    assert.equal((await other.tenantClient.call("GET", "/api/portal/tenant/parcels")).body.items.length, 0, "isolado por unidade");
  });
});

describe("resumo do proprietário", () => {
  it("só números (sem nomes), só dos imóveis dele", async () => {
    const w = await world("res1@x.com");
    await w.staff.call("POST", "/api/residents", { lease_id: w.leaseId, name: "Filho Secreto", relationship: "filho" });
    const v = (await authorize(w.staff, w.unitId, { name: "Visitante Secreto" })).body.item;
    await w.staff.call("POST", `/api/visitors/${v.id}/entry`, {});
    await w.staff.call("POST", "/api/parcels", { unit_id: w.unitId, description: "Caixa secreta" });
    const r = await w.ownerClient.call("GET", "/api/portal/owner/summary");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 1);
    assert.deepEqual([r.body.items[0].units, r.body.items[0].occupied, r.body.items[0].residents, r.body.items[0].visits_30d, r.body.items[0].parcels_30d], [1, 1, 1, 1, 1]);
    const text = JSON.stringify(r.body);
    assert.ok(!/Secret/.test(text), "nenhum nome sai");
    assert.equal((await w.tenantClient.call("GET", "/api/portal/owner/summary")).status, 403);
    assert.equal((await w.staff.call("GET", "/api/portal/owner/summary")).status, 403);
    const other = await world("res2@x.com");
    assert.equal((await other.ownerClient.call("GET", "/api/portal/owner/summary")).body.items[0].visits_30d, 0, "isolado por organização");
  });
});
