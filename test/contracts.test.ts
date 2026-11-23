import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";
import { findVariables, formatAddress, formatBRL, formatDate, joinNames, render, unknownVariables } from "../src/contractTemplate.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

const TEMPLATE = `CONTRATO DE LOCAÇÃO
Locador: {{locador.nome}} ({{locador.documento}})
Locatário: {{locatario.nome}} ({{locatario.cpf}})
Imóvel: {{imovel.endereco}} — unidade {{unidade.identificacao}}
Aluguel: {{contrato.valor_aluguel}}, vencimento dia {{contrato.dia_vencimento}}
Prazo: {{contrato.data_inicio}} a {{contrato.data_fim}}
Garantia: {{contrato.garantia}}`;

interface Scenario {
  ownerId: number;
  propertyId: number;
  unitId: number;
  tenantId: number;
  templateId: number;
}

/** Cadastros completos para gerar um contrato. */
async function scenario(c: Client, tag: string, opts: { owners?: boolean } = {}): Promise<Scenario> {
  const owner = (await c.call("POST", "/api/owners", { name: `Dono ${tag}`, document: `111${tag}` })).body.item;
  const property = (
    await c.call("POST", "/api/properties", {
      name: `Prédio ${tag}`,
      type: "apartamento",
      street: "Rua das Flores",
      number: "100",
      neighborhood: "Centro",
      city: "São Paulo",
      state: "SP",
      zip: "01000-000",
    })
  ).body.item;
  if (opts.owners !== false) {
    assert.equal((await c.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] })).status, 200);
  }
  const unit = (await c.call("POST", "/api/units", { property_id: property.id, identifier: `Apto ${tag}` })).body.item;
  const tenant = (await c.call("POST", "/api/tenants", { name: `Inquilino ${tag}`, document: `222${tag}` })).body.item;
  const template = (await c.call("POST", "/api/contract-templates", { name: `Modelo ${tag}`, body: TEMPLATE })).body.item;
  return { ownerId: owner.id, propertyId: property.id, unitId: unit.id, tenantId: tenant.id, templateId: template.id };
}

const leaseBody = (s: Scenario, extra: Record<string, unknown> = {}) => ({
  unit_id: s.unitId,
  tenantIds: [s.tenantId],
  start_date: "2026-01-01",
  end_date: "2026-12-31",
  rent_cents: 150000,
  due_day: 5,
  guarantee: "Caução de três aluguéis",
  ...extra,
});

describe("motor de variáveis (unidade)", () => {
  it("encontra, valida e substitui variáveis", () => {
    assert.deepEqual(findVariables("{{a.b}} e {{ c.d }} e {{a.b}}"), ["a.b", "c.d"]);
    assert.deepEqual(unknownVariables("{{locador.nome}} {{locador.nomee}}"), ["locador.nomee"]);
    assert.deepEqual(render("Oi {{x}}", { x: "  Mundo " }), { text: "Oi Mundo" });
  });

  it("não gera quando falta valor e lista o que falta", () => {
    assert.deepEqual(render("{{a}} {{b}} {{c}}", { a: "1", b: "", c: undefined }), { missing: ["b", "c"] });
  });

  it("formata data, dinheiro, nomes e endereço", () => {
    assert.equal(formatDate("2026-11-23"), "23/11/2026");
    assert.equal(formatBRL(150000), "R$ 1.500,00");
    assert.equal(formatBRL(99), "R$ 0,99");
    assert.equal(joinNames(["A"]), "A");
    assert.equal(joinNames(["A", "B", "C"]), "A, B e C");
    assert.equal(
      formatAddress({ street: "Rua X", number: "1", complement: null, neighborhood: "Centro", city: "SP", state: "SP", zip: "01000" }),
      "Rua X, 1, Centro, SP/SP, CEP 01000",
    );
    assert.equal(formatAddress({ street: null, number: "1", complement: null, neighborhood: null, city: null, state: null, zip: null }), "");
  });
});

describe("modelos de contrato", () => {
  it("cria, valida variáveis e versiona só quando o texto muda", async () => {
    const a = await register(base, "tpl@x.com", "Tpl");
    assert.equal((await a.call("POST", "/api/contract-templates", { name: "X", body: "{{locador.nomee}}" })).status, 400);
    assert.equal((await a.call("POST", "/api/contract-templates", { name: "", body: "texto" })).status, 400);

    const created = (await a.call("POST", "/api/contract-templates", { name: "Padrão", body: "Olá {{locatario.nome}}" })).body.item;
    assert.equal(created.version, 1);
    assert.equal((await a.call("POST", "/api/contract-templates", { name: "Padrão", body: "outro" })).status, 409);

    const renamed = (await a.call("PATCH", `/api/contract-templates/${created.id}`, { name: "Padrão 2" })).body.item;
    assert.equal(renamed.version, 1, "renomear não muda a versão");
    const edited = (await a.call("PATCH", `/api/contract-templates/${created.id}`, { body: "Novo {{locatario.nome}}" })).body.item;
    assert.equal(edited.version, 2);
    assert.equal((await a.call("PATCH", `/api/contract-templates/${created.id}`, { body: "{{x.y}}" })).status, 400);

    const vars = (await a.call("GET", "/api/contract-variables")).body.variables;
    assert.ok(vars.some((v: { key: string }) => v.key === "contrato.valor_aluguel"));
  });

  it("isola modelos entre organizações e só admin apaga", async () => {
    const a = await register(base, "tpl-a@x.com", "Tpl A");
    const b = await register(base, "tpl-b@x.com", "Tpl B");
    const t = (await a.call("POST", "/api/contract-templates", { name: "Meu", body: "texto" })).body.item;
    assert.equal((await b.call("GET", "/api/contract-templates")).body.items.length, 0);
    assert.equal((await b.call("PATCH", `/api/contract-templates/${t.id}`, { name: "hack" })).status, 404);
    assert.equal((await b.call("DELETE", `/api/contract-templates/${t.id}`)).status, 404);
    assert.equal((await a.call("DELETE", `/api/contract-templates/${t.id}`)).status, 204);
  });
});

describe("contratos de locação", () => {
  it("valida datas, valores, unidade e locatários", async () => {
    const a = await register(base, "lv-a@x.com", "LV A");
    const b = await register(base, "lv-b@x.com", "LV B");
    const s = await scenario(a, "1");
    const other = await scenario(b, "2");

    const bad = async (extra: Record<string, unknown>) => (await a.call("POST", "/api/leases", leaseBody(s, extra))).status;
    assert.equal(await bad({ end_date: "2025-12-31" }), 400, "término antes do início");
    assert.equal(await bad({ start_date: "2026-02-30" }), 400, "data inexistente");
    assert.equal(await bad({ rent_cents: 0 }), 400);
    assert.equal(await bad({ due_day: 32 }), 400);
    assert.equal(await bad({ tenantIds: [] }), 400);
    assert.equal(await bad({ unit_id: other.unitId }), 400, "unidade de outra organização");
    assert.equal(await bad({ tenantIds: [other.tenantId] }), 400, "locatário de outra organização");
    assert.equal(await bad({}), 201);
  });

  it("não vaza contratos entre organizações", async () => {
    const a = await register(base, "li-a@x.com", "LI A");
    const b = await register(base, "li-b@x.com", "LI B");
    const s = await scenario(a, "3");
    const lease = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;
    assert.equal((await b.call("GET", "/api/leases")).body.items.length, 0);
    assert.equal((await b.call("GET", `/api/leases/${lease.id}`)).status, 404);
    assert.equal((await b.call("PATCH", `/api/leases/${lease.id}`, { notes: "x" })).status, 404);
    assert.equal((await b.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 404);
    assert.equal((await b.call("GET", `/api/leases/${lease.id}/documents`)).status, 404);
    const detail = await a.call("GET", `/api/leases/${lease.id}`);
    assert.equal(detail.body.tenants[0].name, "Inquilino 3");
    assert.equal(detail.body.unit.property_name, "Prédio 3");
  });

  it("segue o ciclo de status e atualiza a situação da unidade", async () => {
    const a = await register(base, "ls-a@x.com", "LS A");
    const s = await scenario(a, "4");
    const lease = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;
    assert.equal(lease.status, "rascunho");

    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "encerrado" })).status, 409);
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "inexistente" })).status, 400);
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 200);
    assert.equal((await a.call("GET", `/api/units/${s.unitId}`)).body.item.status, "ocupada");

    // Vigente: não edita nem exclui.
    assert.equal((await a.call("PATCH", `/api/leases/${lease.id}`, { notes: "x" })).status, 409);
    assert.equal((await a.call("DELETE", `/api/leases/${lease.id}`)).status, 409);
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "rascunho" })).status, 409);

    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "rescindido" })).status, 200);
    assert.equal((await a.call("GET", `/api/units/${s.unitId}`)).body.item.status, "disponivel");
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" })).status, 409, "final");
  });

  it("impede dois contratos vigentes sobrepostos na mesma unidade", async () => {
    const a = await register(base, "lo-a@x.com", "LO A");
    const s = await scenario(a, "5");
    const first = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;
    const overlapping = (await a.call("POST", "/api/leases", leaseBody(s, { start_date: "2026-06-01", end_date: "2027-05-31" }))).body.lease;
    const later = (await a.call("POST", "/api/leases", leaseBody(s, { start_date: "2027-01-01", end_date: "2027-12-31" }))).body.lease;

    assert.equal((await a.call("POST", `/api/leases/${first.id}/status`, { status: "vigente" })).status, 200);
    const blocked = await a.call("POST", `/api/leases/${overlapping.id}/status`, { status: "vigente" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /vigente/);
    // Período que não encosta é permitido, e a unidade continua ocupada ao encerrar o primeiro.
    assert.equal((await a.call("POST", `/api/leases/${later.id}/status`, { status: "vigente" })).status, 200);
    assert.equal((await a.call("POST", `/api/leases/${first.id}/status`, { status: "encerrado" })).status, 200);
    assert.equal((await a.call("GET", `/api/units/${s.unitId}`)).body.item.status, "ocupada");
  });

  it("edita rascunho (inclusive locatários) e só admin exclui rascunho", async () => {
    const a = await register(base, "le-a@x.com", "LE A");
    const s = await scenario(a, "6");
    const second = (await a.call("POST", "/api/tenants", { name: "Segundo", document: "999" })).body.item;
    const lease = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;

    const upd = await a.call("PATCH", `/api/leases/${lease.id}`, { rent_cents: 200000, tenantIds: [s.tenantId, second.id] });
    assert.equal(upd.body.lease.rent_cents, 200000);
    assert.equal((await a.call("GET", `/api/leases/${lease.id}`)).body.tenants.length, 2);
    assert.equal((await a.call("PATCH", `/api/leases/${lease.id}`, { end_date: "2025-01-01" })).status, 400);
    assert.equal((await a.call("PATCH", `/api/leases/${lease.id}`, {})).status, 400);

    // Colaborador não exclui.
    const inviteRes = await a.call("POST", "/api/invitations", { email: "le-col@x.com", role: "colaborador" });
    const token = new URL(inviteRes.body.link).searchParams.get("invite");
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Col", password: "senha-segura-123" });
    assert.equal((await col.call("DELETE", `/api/leases/${lease.id}`)).status, 403);
    assert.equal((await a.call("DELETE", `/api/leases/${lease.id}`)).status, 204);
  });

  it("protege unidade, imóvel e locatário que têm contrato (409, não 500)", async () => {
    const a = await register(base, "lp-a@x.com", "LP A");
    const s = await scenario(a, "7");
    await a.call("POST", "/api/leases", leaseBody(s));
    assert.equal((await a.call("DELETE", `/api/units/${s.unitId}`)).status, 409);
    assert.equal((await a.call("DELETE", `/api/properties/${s.propertyId}`)).status, 409);
    assert.equal((await a.call("DELETE", `/api/tenants/${s.tenantId}`)).status, 409);
  });

  it("papéis sem permissão recebem 403 e anônimos 401", async () => {
    const a = await register(base, "lr-a@x.com", "LR A");
    assert.equal((await new Client(base).call("GET", "/api/leases")).status, 401);
    const { db } = await import("../src/db.js");
    const me = (await a.call("GET", "/api/auth/me")).body;
    await db.query("UPDATE organization_members SET role = 'inquilino' WHERE user_id = $1", [me.user.id]);
    assert.equal((await a.call("GET", "/api/leases")).status, 403);
    assert.equal((await a.call("GET", "/api/contract-templates")).status, 403);
  });
});

describe("documentos gerados", () => {
  it("recusa gerar quando faltam dados e informa quais", async () => {
    const a = await register(base, "d1@x.com", "D1");
    const s = await scenario(a, "8", { owners: false });
    const lease = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;

    const r = await a.call("POST", `/api/leases/${lease.id}/preview`, { templateId: s.templateId });
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.missing, ["locador.nome", "locador.documento"]);
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/documents`, { templateId: s.templateId })).status, 422);
    assert.equal((await a.call("GET", `/api/leases/${lease.id}/documents`)).body.items.length, 0);

    assert.equal((await a.call("POST", `/api/leases/${lease.id}/preview`, { templateId: 999999 })).status, 400);
  });

  it("gera o texto com os dados reais e o documento emitido fica imutável", async () => {
    const a = await register(base, "d2@x.com", "D2");
    const s = await scenario(a, "9");
    const lease = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;

    const preview = await a.call("POST", `/api/leases/${lease.id}/preview`, { templateId: s.templateId });
    assert.equal(preview.status, 200);
    const text: string = preview.body.content;
    assert.match(text, /Locador: Dono 9 \(1119\)/);
    assert.match(text, /Locatário: Inquilino 9 \(2229\)/);
    assert.match(text, /Imóvel: Rua das Flores, 100, Centro, São Paulo\/SP, CEP 01000-000 — unidade Apto 9/);
    assert.match(text, /Aluguel: R\$ 1\.500,00, vencimento dia 5/);
    assert.match(text, /Prazo: 01\/01\/2026 a 31\/12\/2026/);
    assert.match(text, /Garantia: Caução de três aluguéis/);
    assert.doesNotMatch(text, /\{\{/);
    assert.equal((await a.call("GET", `/api/leases/${lease.id}/documents`)).body.items.length, 0, "preview não grava");

    const doc = (await a.call("POST", `/api/leases/${lease.id}/documents`, { templateId: s.templateId })).body.document;
    assert.equal(doc.template_version, 1);

    // Alterações posteriores no cadastro e no modelo não mexem no documento emitido.
    await a.call("PATCH", `/api/tenants/${s.tenantId}`, { name: "Nome Alterado" });
    await a.call("PATCH", `/api/leases/${lease.id}`, { rent_cents: 999999 });
    await a.call("PATCH", `/api/contract-templates/${s.templateId}`, { body: "Texto novo {{locatario.nome}}" });

    const stored = (await a.call("GET", `/api/documents/${doc.id}`)).body.document;
    assert.equal(stored.content, text);
    assert.equal(stored.template_version, 1);
    assert.equal(stored.variables["locatario.nome"], "Inquilino 9");

    const second = (await a.call("POST", `/api/leases/${lease.id}/documents`, { templateId: s.templateId })).body.document;
    assert.equal(second.template_version, 2);
    const list = (await a.call("GET", `/api/leases/${lease.id}/documents`)).body.items;
    assert.equal(list.length, 2);
    assert.equal(list[0].id, second.id, "mais recente primeiro");

    // Apagar o modelo não apaga documentos já emitidos.
    await a.call("DELETE", `/api/contract-templates/${s.templateId}`);
    assert.equal((await a.call("GET", `/api/documents/${doc.id}`)).status, 200);
  });

  it("não expõe documentos nem gera contratos entre organizações", async () => {
    const a = await register(base, "d3-a@x.com", "D3 A");
    const b = await register(base, "d3-b@x.com", "D3 B");
    const s = await scenario(a, "10");
    const t = await scenario(b, "11");
    const lease = (await a.call("POST", "/api/leases", leaseBody(s))).body.lease;
    const doc = (await a.call("POST", `/api/leases/${lease.id}/documents`, { templateId: s.templateId })).body.document;

    assert.equal((await b.call("GET", `/api/documents/${doc.id}`)).status, 404);
    assert.equal((await b.call("POST", `/api/leases/${lease.id}/preview`, { templateId: t.templateId })).status, 404);
    // Modelo de outra organização não pode ser usado no meu contrato.
    assert.equal((await a.call("POST", `/api/leases/${lease.id}/preview`, { templateId: t.templateId })).status, 400);
  });
});
