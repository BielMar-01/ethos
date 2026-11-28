import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";
import { STARTERS } from "../src/contractStarters.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

interface Fix {
  id: string;
  section: string;
  label: string;
  input: string;
  options?: { value: string }[];
  adminOnly?: boolean;
}

/** Cadastro "cru", como o de quem já usava o sistema: sem qualificação, sem dados da empresa, sem garantia e sem proprietário no imóvel. */
async function bare(c: Client, tag: string, body = STARTERS[0]!.body) {
  const owner = (await c.call("POST", "/api/owners", { name: "Olga Dona", document: `1${tag}` })).body.item;
  const prop = (await c.call("POST", "/api/properties", { name: "Casa", type: "casa" })).body.item;
  const unit = (await c.call("POST", "/api/units", { property_id: prop.id, identifier: "1" })).body.item;
  const tenant = (await c.call("POST", "/api/tenants", { name: "Teo Locatário", document: `2${tag}` })).body.item;
  const lease = (await c.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2027-01-01", end_date: "2027-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
  const tpl = (await c.call("POST", "/api/contract-templates", { name: `M ${tag}`, body })).body.item;
  const preview = () => c.call("POST", `/api/leases/${lease.id}/preview`, { templateId: tpl.id });
  const fill = (values: Record<string, unknown>) => c.call("POST", `/api/leases/${lease.id}/document-data`, { templateId: tpl.id, values });
  return { ownerId: owner.id as number, propId: prop.id as number, unitId: unit.id as number, tenantId: tenant.id as number, leaseId: lease.id as number, templateId: tpl.id as number, preview, fill };
}

/** Um valor válido para cada tipo de campo pedido. */
const answer = (f: Fix): unknown => {
  if (f.input === "multi") return [Number(f.options![0]!.value)];
  if (f.input === "select") return f.options![0]!.value;
  if (f.input === "money") return 300000;
  if (f.input === "number") return 3;
  if (f.input === "email") return "contato@x.example.com";
  if (f.id.endsWith(":state")) return "sp";
  if (f.id.endsWith(":zip")) return "01000000";
  return `valor ${f.id.split(":").at(-1)}`;
};

describe("completar dados do contrato na própria tela", () => {
  it("o modelo padrão aponta cada campo que falta e, preenchendo, o documento sai; nada além disso é gravável", async () => {
    const c = await register(base, "fill@x.com", "Fill");
    const s = await bare(c, "1");

    const first = await s.preview();
    assert.equal(first.status, 422);
    const ids = (first.body.fixes as Fix[]).map((f) => f.id);
    for (const id of ["property:owners", `tenant:${s.tenantId}:rg`, `tenant:${s.tenantId}:marital_status`, "company:legal_name", "company:company_whatsapp", "property:street", "property:city", "unit:energy_installation", "unit:water_supply", "guarantee:amount"]) {
      assert.ok(ids.includes(id), `faltou pedir ${id}: ${ids.join(",")}`);
    }
    assert.equal(new Set(ids).size, ids.length, "sem campo repetido");
    assert.deepEqual(first.body.unresolved, []);

    // Parte agora, parte depois: o que sobrar volta a ser pedido (agora também a qualificação do proprietário vinculado).
    const part = await s.fill({ "property:owners": [s.ownerId], [`tenant:${s.tenantId}:rg`]: "9 SSP", "unit:water_supply": "W-1", "company:cnpj": "" });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    assert.equal(part.body.saved, 3, "campo em branco é ignorado");
    const second = await s.preview();
    const ids2 = (second.body.fixes as Fix[]).map((f) => f.id);
    assert.ok(ids2.includes(`owner:${s.ownerId}:rg`) && !ids2.includes(`tenant:${s.tenantId}:rg`) && !ids2.includes("unit:water_supply"));

    const all = Object.fromEntries((second.body.fixes as Fix[]).map((f) => [f.id, answer(f)]));
    const rest = await s.fill(all);
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const ok = await s.preview();
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.content.includes("equivalente a 3 meses") && ok.body.content.includes("R$ 3.000,00"));

    // Foi para o cadastro certo, com a formatação de sempre.
    assert.equal((await c.call("GET", `/api/tenants/${s.tenantId}`)).body.item.rg, "9 SSP");
    const prop = (await c.call("GET", `/api/properties/${s.propId}`)).body.item;
    assert.deepEqual([prop.state, prop.zip], ["SP", "01000-000"]);
    assert.equal((await c.call("GET", `/api/units/${s.unitId}`)).body.item.water_supply, "W-1");
    const guarantees = (await c.call("GET", `/api/leases/${s.leaseId}/guarantees`)).body.items;
    assert.deepEqual([guarantees.length, guarantees[0].kind, guarantees[0].amount_cents, guarantees[0].details.months], [1, "caucao", 300000, "3"]);

    assert.equal((await s.fill({ "unit:water_supply": "outro" })).status, 409, "nada mais pendente");
  });

  it("dados da empresa são opcionais: sem eles o documento sai com linha em branco, avisa e mantém a assinatura", async () => {
    const c = await register(base, "fill-opt@x.com", "Fill Opt");
    const s = await bare(c, "9", "**ADMINISTRADORA:** {{administradora.razao_social}}, CNPJ {{administradora.cnpj}}. Locatário {{locatario.nome}}.\n[[assinaturas]]");
    const p = await s.preview();
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.ok(p.body.content.includes("**ADMINISTRADORA:** ______________, CNPJ ______________."));
    assert.match(p.body.warnings.join(" "), /Dados da empresa em branco \(Razão social, CNPJ\)/);
    assert.ok(p.body.layout.signers.some((x: { role: string; name: string }) => x.role.startsWith("ADMINISTRADORA") && x.name === "______________"));
    assert.equal((await c.call("POST", `/api/leases/${s.leaseId}/documents`, { templateId: s.templateId })).status, 201);

    // Com o modelo padrão, a falta continua bloqueando só o que é obrigatório; a empresa aparece como opcional.
    const full = await bare(c, "10");
    const r = await full.preview();
    assert.equal(r.status, 422);
    assert.ok(!r.body.missing.some((m: string) => m.startsWith("administradora.")), JSON.stringify(r.body.missing));
    const company = (r.body.fixes as (Fix & { optional?: boolean })[]).filter((f) => f.id.startsWith("company:"));
    assert.ok(company.length >= 6 && company.every((f) => f.optional));
    // Preenchendo só o obrigatório (quantas rodadas precisar), o documento sai.
    for (let round = 0; round < 3; round++) {
      const now = await full.preview();
      if (now.status === 200) break;
      const required = (now.body.fixes as (Fix & { optional?: boolean })[]).filter((f) => !f.optional);
      assert.equal((await full.fill(Object.fromEntries(required.map((f) => [f.id, answer(f)])))).status, 200);
    }
    const done = await full.preview();
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.content.includes("com sede em ______________"));
    assert.equal((await c.call("GET", "/api/settings/company")).body.company.legal_name, null);
  });

  it("não sobrescreve dado existente, valida os valores e é tudo ou nada", async () => {
    const c = await register(base, "fill2@x.com", "Fill2");
    const s = await bare(c, "2", "RG {{locatario.rg}} · {{locatario.estado_civil}} · {{unidade.quartos}} · {{locatario.email}} · {{contrato.indice_reajuste}}");
    await c.call("PATCH", `/api/tenants/${s.tenantId}`, { rg: "ORIGINAL" });

    assert.equal((await s.fill({ [`tenant:${s.tenantId}:rg`]: "SOBRESCRITO" })).status, 409, "campo já preenchido não está na lista");
    assert.equal((await s.fill({ [`tenant:${s.tenantId}:name`]: "Hack" })).status, 409);
    // Misturado: o que já estava preenchido é ignorado (mantido) e o resto é salvo.
    const mixed = await s.fill({ [`tenant:${s.tenantId}:rg`]: "SOBRESCRITO", [`tenant:${s.tenantId}:email`]: "teo@x.example.com" });
    assert.deepEqual([mixed.status, mixed.body.saved, mixed.body.skipped], [200, 1, 1], JSON.stringify(mixed.body));
    assert.equal((await c.call("GET", `/api/tenants/${s.tenantId}`)).body.item.rg, "ORIGINAL");
    assert.equal((await s.fill({ [`tenant:${s.tenantId}:email`]: "outro@x.example.com" })).body.stale, true);
    await c.call("PATCH", `/api/tenants/${s.tenantId}`, { email: null });
    assert.equal((await s.fill({ "company:cnpj": "1" })).status, 409, "o modelo não pede");
    assert.equal((await s.fill({})).status, 400);
    assert.equal((await c.call("POST", `/api/leases/${s.leaseId}/document-data`, { templateId: s.templateId })).status, 400);
    assert.equal((await s.fill({ [`tenant:${s.tenantId}:marital_status`]: "inventado" })).status, 400);
    assert.equal((await s.fill({ [`tenant:${s.tenantId}:email`]: "semarroba" })).status, 400);
    assert.equal((await s.fill({ "unit:bedrooms": -1 })).status, 400);
    // Um valor ruim cancela o envio inteiro.
    assert.equal((await s.fill({ "lease:adjust_index": "IPCA", "unit:bedrooms": 1.5 })).status, 400);
    assert.equal((await c.call("GET", `/api/leases/${s.leaseId}`)).body.lease.adjust_index, null);
    assert.equal((await c.call("GET", `/api/tenants/${s.tenantId}`)).body.item.rg, "ORIGINAL");

    // Contrato já vigente também pode ter as lacunas preenchidas.
    await c.call("POST", `/api/leases/${s.leaseId}/status`, { status: "vigente" });
    assert.equal((await s.fill({ "lease:adjust_index": "IPCA", "unit:bedrooms": 0 })).status, 200);
    assert.equal((await c.call("GET", `/api/leases/${s.leaseId}`)).body.lease.adjust_index, "IPCA");
  });

  it("dados da empresa só o admin; outra organização não alcança; multa e fiador explicam onde resolver", async () => {
    const admin = await register(base, "fill3@x.com", "Fill3");
    const s = await bare(admin, "3", "{{administradora.cnpj}} {{contrato.multa_atraso}} {{fiador.nome}}");
    const p = await s.preview();
    assert.deepEqual((p.body.fixes as Fix[]).map((f) => [f.id, f.adminOnly]), [["company:cnpj", true]]);
    assert.equal(p.body.unresolved.length, 2);
    assert.match(p.body.unresolved.join(" "), /Financeiro/);
    assert.match(p.body.unresolved.join(" "), /fiador/);

    const inv = await admin.call("POST", "/api/invitations", { email: "fill3-col@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${new URL(inv.body.link).searchParams.get("invite")}/accept`, { name: "Col", password: "senha-segura-123" });
    const body = { templateId: s.templateId, values: { "company:cnpj": "00000000000100" } };
    assert.equal((await col.call("POST", `/api/leases/${s.leaseId}/document-data`, body)).status, 403);

    const other = await register(base, "fill3-b@x.com", "Fill3 B");
    assert.equal((await other.call("POST", `/api/leases/${s.leaseId}/document-data`, body)).status, 404);
    assert.equal((await new Client(base).call("POST", `/api/leases/${s.leaseId}/document-data`, body)).status, 401);
    assert.equal((await admin.call("POST", `/api/leases/${s.leaseId}/document-data`, body)).status, 200);

    // Proprietário de outra organização não pode ser vinculado ao meu imóvel.
    const mine = await bare(admin, "4", "{{locador.nome}}");
    const foreign = (await other.call("POST", "/api/owners", { name: "Alheio", document: "77" })).body.item;
    assert.equal((await mine.fill({ "property:owners": [foreign.id] })).status, 400);
  });
});
