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
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function world(tag: string, opts: { start?: string; end?: string; rent?: number } = {}) {
  const c = await register(base, `c2${tag}@x.com`, `C2 ${tag}`);
  const owner = (await c.call("POST", "/api/owners", { name: `Dono ${tag}`, document: `9${tag}` })).body.item;
  const property = (await c.call("POST", "/api/properties", { name: `Prédio ${tag}`, type: "apartamento", city: "Campinas", neighborhood: "Centro" })).body.item;
  await c.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
  const unit = (await c.call("POST", "/api/units", { property_id: property.id, identifier: `U${tag}`, bedrooms: 2, area_m2: 60, rent_reference_cents: 150000 })).body.item;
  const tenant = (await c.call("POST", "/api/tenants", { name: `Maria Inquilina ${tag}`, document: `8${tag}` })).body.item;
  const lease = (await c.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: opts.start ?? "2024-01-01", end_date: opts.end ?? "2030-12-31", rent_cents: opts.rent ?? 100000, due_day: 5 })).body.lease;
  assert.equal((await c.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
  return { c, ownerId: owner.id as number, propertyId: property.id as number, unitId: unit.id as number, tenantId: tenant.id as number, leaseId: lease.id as number };
}
const leaseOf = async (c: Client, id: number) => (await c.call("GET", `/api/leases/${id}`)).body;

describe("aditivos: renovação e reajuste", () => {
  it("renova o prazo e reajusta o aluguel (percentual ou valor), com texto e aplicação imediata", async () => {
    const w = await world("11", { rent: 100000 });
    const add = (b: Record<string, unknown>) => w.c.call("POST", `/api/leases/${w.leaseId}/addenda`, b);
    assert.equal((await add({ kind: "x" })).status, 400);
    assert.equal((await add({ kind: "renovacao" })).status, 400, "falta o novo prazo");
    assert.equal((await add({ kind: "renovacao", new_end_date: "2029-01-01" })).status, 400, "antes do fim atual");
    assert.equal((await add({ kind: "reajuste" })).status, 400);
    assert.equal((await add({ kind: "reajuste", index_percent: 500 })).status, 400);
    assert.equal((await add({ kind: "aditivo" })).status, 400);

    const ren = await add({ kind: "renovacao", new_end_date: "2032-12-31", notes: "Renovado por 2 anos" });
    assert.equal(ren.status, 201, JSON.stringify(ren.body));
    assert.equal(ren.body.applied, true);
    assert.match(ren.body.content, /TERMO DE RENOVAÇÃO/);
    assert.match(ren.body.content, /31\/12\/2032/);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.end_date.slice(0, 10), "2032-12-31");

    const rea = await add({ kind: "reajuste", index_percent: 4.5, index_name: "IGP-M" });
    assert.equal(rea.status, 201);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.rent_cents, 104500);
    assert.match(rea.body.content, /R\$\s?1\.045,00/);
    assert.match(rea.body.content, /4,5%/);
    const list = (await w.c.call("GET", `/api/leases/${w.leaseId}/addenda`)).body.items;
    assert.equal(list.length, 2);
    assert.equal(list[0].previous_rent_cents, 100000);
    const fixed = await add({ kind: "reajuste", new_rent_cents: 120000 });
    assert.equal(fixed.status, 201);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.rent_cents, 120000);
    assert.equal((await new Client(base).call("GET", `/api/leases/${w.leaseId}/addenda`)).status, 401);
  });

  it("aditivo com data futura fica agendado e entra em vigor pelo job; não invade outro contrato", async () => {
    const { applyDueAddenda } = await import("../src/contracts2.js");
    const { db } = await import("../src/db.js");
    const w = await world("12", { rent: 100000 });
    const fut = await w.c.call("POST", `/api/leases/${w.leaseId}/addenda`, { kind: "reajuste", new_rent_cents: 110000, effective_from: inDays(10) });
    assert.equal(fut.body.applied, false);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.rent_cents, 100000, "ainda não vale");
    assert.equal(await applyDueAddenda(), 0);
    await db.query("UPDATE lease_addenda SET effective_from = $1::date WHERE id = $2", [today, fut.body.id]);
    assert.equal(await applyDueAddenda(), 1);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.rent_cents, 110000);
    assert.equal(await applyDueAddenda(), 0, "uma vez só");

    // Contrato curto seguido de outro vigente na mesma unidade: estender o primeiro sobreporia.
    const x = await world("13", { start: "2024-01-01", end: "2025-12-31" });
    const t2 = (await x.c.call("POST", "/api/tenants", { name: "Outro Inq", document: "7139" })).body.item;
    const l2 = (await x.c.call("POST", "/api/leases", { unit_id: x.unitId, tenantIds: [t2.id], start_date: "2026-01-01", end_date: "2030-12-31", rent_cents: 90000, due_day: 5 })).body.lease;
    assert.equal((await x.c.call("POST", `/api/leases/${l2.id}/status`, { status: "vigente" })).status, 200);
    const clash = await x.c.call("POST", `/api/leases/${x.leaseId}/addenda`, { kind: "renovacao", new_end_date: "2026-06-30" });
    assert.equal(clash.status, 409);
    assert.equal((await w.c.call("POST", "/api/leases/999999/addenda", { kind: "aditivo", new_rent_cents: 1 })).status, 404);
  });

  it("consulta o acumulado de IGP-M/IPCA no Banco Central e avisa se a consulta falhar", async () => {
    const { setIndexFetch } = await import("../src/contracts2.js");
    const w = await world("14");
    setIndexFetch((async (url: string) => {
      assert.match(String(url), /bcdata\.sgs\.189\/dados\/ultimos\/3/);
      return new Response(JSON.stringify([{ data: "01/01/2026", valor: "0.50" }, { data: "01/02/2026", valor: "1.00" }, { data: "01/03/2026", valor: "-0.20" }]), { status: 200 });
    }) as never);
    try {
      const r = await w.c.call("GET", "/api/indices/accumulated?index=igpm&months=3");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.accumulated_percent, 1.302, "(1,005 × 1,01 × 0,998 − 1)");
      assert.equal(r.body.index, "IGP-M");
      assert.equal((await w.c.call("GET", "/api/indices/accumulated?index=selic")).status, 400);
      setIndexFetch((async () => new Response("erro", { status: 500 })) as never);
      assert.equal((await w.c.call("GET", "/api/indices/accumulated?index=ipca")).status, 502);
    } finally {
      setIndexFetch(null);
    }
  });
});

describe("rescisão guiada", () => {
  it("calcula a multa proporcional, rescinde, gera a cobrança e cancela aluguéis futuros", async () => {
    const w = await world("21", { start: "2026-01-01", end: "2026-12-31", rent: 100000 });
    const prev = await w.c.call("POST", `/api/leases/${w.leaseId}/terminate/preview`, { date: "2026-07-01", fine_months: 3 });
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    assert.equal(prev.body.total_days, 365);
    assert.equal(prev.body.remaining_days, 183);
    assert.equal(prev.body.fine_base_cents, 300000);
    assert.equal(prev.body.fine_cents, Math.round((300000 * 183) / 365), "multa × dias restantes ÷ dias do contrato");
    assert.equal((await w.c.call("POST", `/api/leases/${w.leaseId}/terminate/preview`, { date: "2020-01-01" })).status, 400);
    assert.equal((await w.c.call("POST", `/api/leases/${w.leaseId}/terminate/preview`, { fine_months: 40 })).status, 400);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.status, "vigente", "prévia não muda nada");

    await w.c.call("POST", "/api/charges/generate", { month: "2026-09" });
    const done = await w.c.call("POST", `/api/leases/${w.leaseId}/terminate`, { date: "2026-07-01", fine_months: 3, cancel_future_charges: true, reason: "Mudança de cidade" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.status, "rescindido");
    assert.ok(done.body.fine_charge_id);
    assert.equal(done.body.cancelled_charges, 1);
    assert.equal((await leaseOf(w.c, w.leaseId)).lease.status, "rescindido");
    assert.equal((await w.c.call("GET", `/api/units/${w.unitId}`)).body.item.status, "disponivel");
    const fine = (await w.c.call("GET", "/api/charges?month=2026-07")).body.items.find((c: { kind: string }) => c.kind === "multa");
    assert.equal(fine.amount_cents, prev.body.fine_cents);
    assert.match(fine.description, /Multa rescisória/);
    const term = (await w.c.call("GET", `/api/leases/${w.leaseId}/termination`)).body.item;
    assert.equal(term.reason, "Mudança de cidade");
    assert.equal((await w.c.call("POST", `/api/leases/${w.leaseId}/terminate`, {})).status, 409, "já rescindido");
  });

  it("isenção da multa não cria cobrança", async () => {
    const w = await world("22", { start: "2026-01-01", end: "2026-12-31" });
    const r = await w.c.call("POST", `/api/leases/${w.leaseId}/terminate`, { date: "2026-03-01", waive_fine: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.fine_charge_id, null);
    const t = (await w.c.call("GET", `/api/leases/${w.leaseId}/termination`)).body.item;
    assert.equal(t.fine_waived, true);
  });
});

describe("garantias", () => {
  it("valida por tipo, altera, libera e avisa quando perto de vencer", async () => {
    const { runGuaranteeAlerts } = await import("../src/contracts2.js");
    const w = await world("31");
    const add = (b: Record<string, unknown>) => w.c.call("POST", `/api/leases/${w.leaseId}/guarantees`, b);
    assert.equal((await add({ kind: "fiador", details: { name: "João" } })).status, 400, "falta documento");
    assert.equal((await add({ kind: "caucao" })).status, 400, "falta valor");
    assert.equal((await add({ kind: "seguro_fianca", details: { insurer: "X", policy_number: "1" } })).status, 400, "falta vigência");
    assert.equal((await add({ kind: "titulo" })).status, 400);
    const fiador = await add({ kind: "fiador", details: { name: "João Fiador", document: "11122233344", phone: "11999990000" } });
    assert.equal(fiador.status, 201, JSON.stringify(fiador.body));
    const caucao = await add({ kind: "caucao", amount_cents: 300000, details: { months: "3" } });
    assert.equal(caucao.status, 201);
    const seguro = await add({ kind: "seguro_fianca", valid_until: inDays(20), amount_cents: 500000, details: { insurer: "Porto", policy_number: "ABC-1" } });
    const list = (await w.c.call("GET", `/api/leases/${w.leaseId}/guarantees`)).body.items;
    assert.equal(list.length, 3);
    assert.equal(list[0].details.name, "João Fiador");

    assert.equal(await runGuaranteeAlerts(), (await w.c.call("GET", "/api/notifications")).body.unread, "avisa a equipe da garantia que vence em 20 dias");
    assert.equal(await runGuaranteeAlerts(), 0, "um aviso por garantia");
    assert.equal((await w.c.call("PATCH", `/api/guarantees/${caucao.body.id}`, { status: "liberada", notes: "Devolvida ao fim" })).status, 200);
    assert.equal((await w.c.call("PATCH", `/api/guarantees/${caucao.body.id}`, { status: "x" })).status, 400);
    assert.equal((await w.c.call("PATCH", `/api/guarantees/${seguro.body.id}`, { valid_until: inDays(400) })).status, 200);
    assert.equal((await w.c.call("DELETE", `/api/guarantees/${fiador.body.id}`)).status, 204);
    assert.equal((await w.c.call("GET", `/api/leases/${w.leaseId}/guarantees`)).body.items.length, 2);
    const other = await world("32");
    assert.equal((await other.c.call("PATCH", `/api/guarantees/${caucao.body.id}`, { notes: "x" })).status, 404, "isolado por organização");
  });
});

describe("assinatura eletrônica simples", () => {
  async function document(w: Awaited<ReturnType<typeof world>>) {
    const tpl = (await w.c.call("POST", "/api/contract-templates", { name: "Contrato padrão", body: "Contrato entre {{locador.nome}} e {{locatario.nome}}. Aluguel de {{contrato.valor_aluguel}}." })).body.item;
    const doc = await w.c.call("POST", `/api/leases/${w.leaseId}/documents`, { templateId: tpl.id });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    return doc.body.document.id as number;
  }
  const tokenOf = (link: string) => new URL(link).searchParams.get("sign")!;

  it("coleta assinaturas por link, exige o nome certo, completa e emite o certificado", async () => {
    const { memoryMailer } = await import("../src/mailer.js");
    const w = await world("41");
    const docId = await document(w);
    assert.equal((await w.c.call("POST", `/api/documents/${docId}/signature`, { signers: [] })).status, 400);
    assert.equal((await w.c.call("POST", `/api/documents/${docId}/signature`, { signers: [{ name: "Ab", role: "locador" }] })).status, 400);
    const start = await w.c.call("POST", `/api/documents/${docId}/signature`, { signers: [{ name: "Maria Inquilina 41", email: "maria41@mail.com", role: "locatario" }, { name: "Carlos Dono", role: "locador" }] });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    assert.equal(start.body.emailed, 1);
    assert.match(start.body.content_hash, /^[0-9a-f]{64}$/);
    assert.ok(memoryMailer.outbox.some((m) => m.to === "maria41@mail.com" && /\?sign=/.test(m.text)));
    assert.equal((await w.c.call("POST", `/api/documents/${docId}/signature`, { signers: [{ name: "Fulano de Tal", role: "locador" }] })).status, 409, "já em andamento");
    assert.equal((await w.c.call("GET", `/api/documents/${docId}/signature/certificate`)).status, 409, "ainda não concluiu");

    const [maria, carlos] = start.body.links.map((l: { link: string }) => tokenOf(l.link));
    const anon = new Client(base);
    const view = await anon.call("GET", `/api/sign/${maria}`);
    assert.equal(view.status, 200);
    assert.match(view.body.document.content, /Contrato entre/);
    assert.equal(view.body.signer.name, "Maria Inquilina 41");
    assert.equal(view.body.others.length, 2);
    assert.equal((await anon.call("GET", "/api/sign/token-que-nao-existe-123")).status, 404);

    assert.equal((await anon.call("POST", `/api/sign/${maria}`, { signed_name: "Maria Inquilina 41" })).status, 400, "sem aceitar");
    assert.equal((await anon.call("POST", `/api/sign/${maria}`, { signed_name: "Outra Pessoa", accept: true })).status, 400, "nome errado");
    const ok = await anon.call("POST", `/api/sign/${maria}`, { signed_name: "  maria inquilina 41 ", accept: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.completed, false);
    assert.equal((await anon.call("POST", `/api/sign/${maria}`, { signed_name: "Maria Inquilina 41", accept: true })).status, 409, "assina uma vez");
    assert.equal((await anon.call("POST", `/api/sign/${carlos}`, { signed_name: "Carlos Dono", accept: true })).body.completed, true);

    const status = (await w.c.call("GET", `/api/documents/${docId}/signature`)).body.item;
    assert.equal(status.status, "concluida");
    assert.ok(status.signers.every((s: { signed_at: string | null; signed_ip: string | null }) => s.signed_at && s.signed_ip));
    assert.ok(!JSON.stringify(status).includes(maria), "os tokens nunca voltam");
    const cert = await fetch(`${base}/api/documents/${docId}/signature/certificate`, { headers: { Cookie: w.c.cookie } });
    const text = await cert.text();
    assert.match(text, /CERTIFICADO DE ASSINATURA ELETRÔNICA SIMPLES/);
    assert.match(text, new RegExp(start.body.content_hash));
    assert.match(text, /Maria Inquilina 41 \(locatario\)/);
    assert.equal((await anon.call("GET", `/api/sign/${maria}`)).body.status, "concluida");
    const note = (await w.c.call("GET", "/api/notifications")).body.items.map((n: { title: string }) => n.title);
    assert.ok(note.includes("Documento totalmente assinado"));
  });

  it("cancelar invalida os links; outra organização não vê o documento", async () => {
    const w = await world("42");
    const docId = await document(w);
    const s = await w.c.call("POST", `/api/documents/${docId}/signature`, { signers: [{ name: "Fulano de Tal", role: "locatario" }] });
    const token = tokenOf(s.body.links[0].link);
    const other = await world("43");
    assert.equal((await other.c.call("POST", `/api/documents/${docId}/signature`, { signers: [{ name: "Fulano de Tal", role: "locatario" }] })).status, 404);
    assert.equal((await w.c.call("POST", `/api/documents/${docId}/signature/cancel`)).status, 204);
    assert.equal((await new Client(base).call("GET", `/api/sign/${token}`)).status, 404);
    assert.equal((await w.c.call("POST", `/api/documents/${docId}/signature/cancel`)).status, 404);
    assert.equal((await w.c.call("POST", `/api/documents/${docId}/signature`, { signers: [{ name: "Novo Signatário", role: "locatario" }] })).status, 201, "pode iniciar outra");
  });
});

describe("captação: vitrine, interessados, visitas e crédito", () => {
  it("vitrine pública liga/desliga, lista só disponíveis sem endereço completo e recebe interesse com proteção", async () => {
    const w = await world("51");
    const free = (await w.c.call("POST", "/api/units", { property_id: w.propertyId, identifier: "Livre 1", bedrooms: 3, area_m2: 80, rent_reference_cents: 200000 })).body.item;
    assert.equal((await w.c.call("GET", "/api/settings/public-listing")).body.enabled, false);
    const on = await w.c.call("PUT", "/api/settings/public-listing", { enabled: true });
    assert.equal(on.body.enabled, true);
    const token = on.body.link.split("/").pop();
    const again = await w.c.call("PUT", "/api/settings/public-listing", { enabled: true });
    assert.equal(again.body.link, on.body.link, "ligar de novo não troca o link");

    const anon = new Client(base);
    const list = await anon.call("GET", `/api/public/listings/${token}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((u: { identifier: string }) => u.identifier), ["Livre 1"], "a unidade ocupada não aparece");
    assert.ok(!JSON.stringify(list.body).includes("street"));
    assert.equal((await anon.call("GET", "/api/public/listings/token-invalido-123456")).status, 404);

    const post = (b: Record<string, unknown>) => anon.call("POST", "/api/public/interest", { token, name: "Ana Interessada", phone: "11987654321", consent: true, ...b });
    assert.equal((await post({ consent: false })).status, 400);
    assert.equal((await post({ phone: "1", email: "" })).status, 400);
    assert.equal((await post({ token: "nada-nada-nada-1" })).status, 404);
    assert.equal((await post({ website: "http://spam" })).status, 204, "robô: finge sucesso e não grava");
    const ok = await post({ unit_id: free.id, message: "Aceita pets?" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const leads = (await w.c.call("GET", "/api/leads")).body;
    assert.equal(leads.items.length, 1, "o robô não virou interessado");
    assert.equal(leads.items[0].source, "site");
    assert.equal(leads.items[0].unit_identifier, "Livre 1");
    assert.equal(leads.items[0].phone, "(11) 98765-4321");
    assert.ok((await w.c.call("GET", "/api/notifications")).body.items.some((n: { title: string }) => n.title === "Novo interessado pelo site"));

    for (let i = 0; i < 5; i++) await post({});
    assert.equal((await post({})).status, 429, "limite por IP");
    assert.equal((await w.c.call("PUT", "/api/settings/public-listing", { enabled: false })).body.enabled, false);
    assert.equal((await anon.call("GET", `/api/public/listings/${token}`)).status, 404, "desligada");
  });

  it("funil de interessados e agenda de visitas (sem conflito, lembrete 24 h antes)", async () => {
    const { runVisitReminders } = await import("../src/crm.js");
    const { db } = await import("../src/db.js");
    const w = await world("52");
    assert.equal((await w.c.call("POST", "/api/leads", { name: "Só Nome" })).status, 400, "sem contato");
    assert.equal((await w.c.call("POST", "/api/leads", { name: "X", phone: "11999990000", status: "voando" })).status, 400);
    const lead = (await w.c.call("POST", "/api/leads", { name: "Bruno Prospecto", phone: "11999990000", unit_id: w.unitId, source: "indicacao" })).body.item;
    assert.equal(lead.status, "novo");

    const when = new Date(Date.now() + 5 * 3600_000).toISOString();
    assert.equal((await w.c.call("POST", `/api/leads/${lead.id}/visits`, { scheduled_at: "2020-01-01T10:00:00Z" })).status, 400, "no passado");
    const v = await w.c.call("POST", `/api/leads/${lead.id}/visits`, { scheduled_at: when, unit_id: w.unitId });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    assert.equal((await w.c.call("GET", "/api/leads?status=visita_agendada")).body.items.length, 1, "o funil avança sozinho");
    const clash = await w.c.call("POST", `/api/leads/${lead.id}/visits`, { scheduled_at: new Date(Date.now() + 5 * 3600_000 + 10 * 60_000).toISOString() });
    assert.equal(clash.status, 409, "mesmo responsável ±30 min");

    assert.equal(await runVisitReminders(), 1);
    assert.equal(await runVisitReminders(), 0, "um lembrete só");
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date(when));
    assert.equal((await w.c.call("GET", `/api/lead-visits?from=${day}&to=${day}`)).body.items.length, 1);
    assert.equal((await w.c.call("PATCH", `/api/lead-visits/${v.body.item.id}`, { status: "realizada" })).body.item.status, "realizada");
    assert.equal((await w.c.call("PATCH", `/api/lead-visits/${v.body.item.id}`, { status: "x" })).status, 400);
    const upd = await w.c.call("PATCH", `/api/leads/${lead.id}`, { status: "proposta", notes: "Quer fechar" });
    assert.equal(upd.body.item.status, "proposta");
    assert.equal((await w.c.call("GET", "/api/leads")).body.counts.proposta, 1);
    const other = await world("53");
    assert.equal((await other.c.call("PATCH", `/api/leads/${lead.id}`, { notes: "x" })).status, 404);
    assert.equal((await w.c.call("DELETE", `/api/leads/${lead.id}`)).status, 204);
    assert.ok(db);
  });

  it("análise de crédito: regra de renda × aluguel, consentimento e decisão humana", async () => {
    const { creditRecommendation } = await import("../src/crm.js");
    assert.deepEqual(creditRecommendation(300000, 100000, false), { ratio: 3, recommendation: "aprovar" });
    assert.deepEqual(creditRecommendation(280000, 100000, false), { ratio: 2.8, recommendation: "revisar" });
    assert.deepEqual(creditRecommendation(200000, 100000, false).recommendation, "reprovar");
    assert.deepEqual(creditRecommendation(900000, 100000, true).recommendation, "reprovar", "restrição no nome");

    const w = await world("54");
    const body = { name: "Candidato Teste", document: "529.982.247-25", income_cents: 450000, rent_cents: 150000, consent: true };
    assert.equal((await w.c.call("POST", "/api/credit-checks", { ...body, consent: false })).status, 400);
    assert.equal((await w.c.call("POST", "/api/credit-checks", { ...body, document: "123" })).status, 400);
    assert.equal((await w.c.call("POST", "/api/credit-checks", { ...body, rent_cents: 0 })).status, 400);
    assert.equal((await w.c.call("POST", "/api/credit-checks", { ...body, score: 5000 })).status, 400);
    const r = await w.c.call("POST", "/api/credit-checks", body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.recommendation, "aprovar");
    assert.equal(r.body.ratio, 3);
    assert.equal((await w.c.call("PATCH", `/api/credit-checks/${r.body.id}/decision`, { status: "talvez" })).status, 400);
    assert.equal((await w.c.call("PATCH", `/api/credit-checks/${r.body.id}/decision`, { status: "aprovado", notes: "Fiador incluso" })).status, 200);
    const list = (await w.c.call("GET", "/api/credit-checks")).body.items;
    assert.equal(list[0].status, "aprovado");
    assert.equal((await new Client(base).call("GET", "/api/credit-checks")).status, 401);
    const other = await world("55");
    assert.equal((await other.c.call("PATCH", `/api/credit-checks/${r.body.id}/decision`, { status: "reprovado" })).status, 404);
  });
});

describe("documentos do imóvel", () => {
  const upload = (c: Client, propertyId: number, q: string, body: Buffer | string, type = "application/pdf") =>
    fetch(`${base}/api/properties/${propertyId}/documents?${q}`, { method: "POST", headers: { "Content-Type": type, Cookie: c.cookie }, body: typeof body === "string" ? body : new Uint8Array(body) });
  const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF");

  it("anexa PDF/imagem conferidos pelo conteúdo, lista, baixa, e avisa 30 dias antes e no vencimento", async () => {
    const { runPropertyDocAlerts } = await import("../src/propdocs.js");
    const { db } = await import("../src/db.js");
    const w = await world("61");
    assert.equal((await upload(w.c, w.propertyId, "kind=iptu", PDF)).status, 400, "falta o título");
    assert.equal((await upload(w.c, w.propertyId, "kind=xyz&title=Algo", PDF)).status, 400);
    assert.equal((await upload(w.c, w.propertyId, "kind=iptu&title=IPTU 2026&expires_at=2026-13-45", PDF)).status, 400);
    assert.equal((await upload(w.c, w.propertyId, "kind=iptu&title=IPTU 2026", "isso não é um PDF")).status, 400, "magic bytes");
    assert.equal((await upload(w.c, 999999, "kind=iptu&title=IPTU 2026", PDF)).status, 404);

    const seguro = await upload(w.c, w.propertyId, `kind=seguro&title=Seguro incêndio&expires_at=${inDays(20)}`, PDF);
    assert.equal(seguro.status, 201, await seguro.clone().text());
    const matricula = await upload(w.c, w.propertyId, "kind=matricula&title=Matrícula", JPEG, "image/jpeg");
    assert.equal(matricula.status, 201);
    const list = (await w.c.call("GET", `/api/properties/${w.propertyId}/documents`)).body.items;
    assert.equal(list.length, 2);
    assert.equal(list[0].title, "Seguro incêndio", "com vencimento primeiro");
    assert.ok(!JSON.stringify(list).includes("data"));
    const id = (await seguro.json()).id;
    const file = await fetch(`${base}/api/property-documents/${id}/file`, { headers: { Cookie: w.c.cookie } });
    assert.equal(file.headers.get("content-type"), "application/pdf");
    assert.equal(file.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
    assert.equal((await w.c.call("GET", "/api/property-documents/expiring?days=30")).body.items.length, 1);

    assert.equal(await runPropertyDocAlerts(), (await w.c.call("GET", "/api/notifications")).body.unread, "aviso aos 30 dias");
    assert.equal(await runPropertyDocAlerts(), 0, "não repete");
    await db.query("UPDATE property_documents SET expires_at = $1::date - 1 WHERE id = $2", [today, id]);
    assert.ok((await runPropertyDocAlerts()) >= 1, "e outro quando vence");
    assert.equal((await w.c.call("PATCH", `/api/property-documents/${id}`, { expires_at: inDays(365) })).status, 200);
    assert.equal(await runPropertyDocAlerts(), 0, "renovado: reinicia sem alertar");

    const other = await world("62");
    assert.equal((await fetch(`${base}/api/property-documents/${id}/file`, { headers: { Cookie: other.c.cookie } })).status, 404);
    assert.equal((await w.c.call("DELETE", `/api/property-documents/${id}`)).status, 204);
    assert.equal((await new Client(base).call("GET", `/api/properties/${w.propertyId}/documents`)).status, 401);
  });
});
