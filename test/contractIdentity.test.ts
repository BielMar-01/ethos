import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";
import { blockError, cleanValue, render, unknownVariables } from "../src/contractTemplate.js";
import { centsToWords, dateToWords, monthsBetween, numberToWords } from "../src/extenso.js";
import { personValues } from "../src/contractData.js";
import { STARTERS } from "../src/contractStarters.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

const PNG = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

describe("extenso (unidade)", () => {
  it("números, valores, datas e prazos", () => {
    const cases: [number, string][] = [
      [0, "zero"], [1, "um"], [16, "dezesseis"], [21, "vinte e um"], [100, "cem"], [101, "cento e um"], [200, "duzentos"],
      [1000, "mil"], [1001, "mil e um"], [1100, "mil e cem"], [1250, "mil duzentos e cinquenta"], [1500, "mil e quinhentos"],
      [2026, "dois mil e vinte e seis"], [100000, "cem mil"], [1000000, "um milhão"], [2500000, "dois milhões e quinhentos mil"],
    ];
    for (const [n, words] of cases) assert.equal(numberToWords(n), words, String(n));
    assert.equal(centsToWords(100), "um real");
    assert.equal(centsToWords(150000), "mil e quinhentos reais");
    assert.equal(centsToWords(180050), "mil e oitocentos reais e cinquenta centavos");
    assert.equal(centsToWords(1), "um centavo");
    assert.equal(centsToWords(100000000), "um milhão de reais");
    assert.equal(dateToWords("2026-11-05"), "5 de novembro de 2026");
    assert.equal(dateToWords("2026-03-01"), "1º de março de 2026");
    assert.equal(monthsBetween("2026-09-20", "2027-09-19"), 12);
    assert.equal(monthsBetween("2026-09-20", "2027-09-20"), 12);
    assert.equal(monthsBetween("2026-01-01", "2026-12-31"), 12);
    assert.equal(monthsBetween("2026-01-01", "2028-06-30"), 30);
  });
});

describe("blocos de partes (unidade)", () => {
  const people = [personValues("locatario", { name: "Ana", document: "1" }, { simple: true }), personValues("locatario", { name: "Bia", document: "2" }, { simple: true })];

  it("repete o parágrafo para cada pessoa e some com fiadores vazios", () => {
    const body = "{{#locatarios}}\nNome: {{locatario.nome}} ({{locatario.documento}}) {{contrato.cidade}}\n{{/locatarios}}\n\n{{#fiadores}}\nFiador {{fiador.nome}}\n{{/fiadores}}\nFim";
    const r = render(body, { "contrato.cidade": "SP" }, { locatarios: people, fiadores: [] }) as { text: string };
    assert.equal(r.text.replace(/\n{2,}/g, "\n").trim(), "Nome: Ana (1) SP\nNome: Bia (2) SP\nFim");
  });

  it("não emite sem locador/locatário e diz de quem falta o dado", () => {
    assert.deepEqual(render("{{#locadores}}x{{/locadores}}", {}, { locadores: [] }), { missing: ["locadores"] });
    assert.deepEqual(render("{{#locatarios}}{{locatario.rg}}{{/locatarios}}", {}, { locatarios: people }), { missing: ["locatario.rg (Ana)", "locatario.rg (Bia)"] });
  });

  it("recusa bloco desconhecido, aninhado ou sem fechamento; variável com erro continua recusada", () => {
    assert.match(blockError("{{#socios}}x{{/socios}}")!, /desconhecido/i);
    assert.match(blockError("{{#locadores}}x")!, /sem abertura ou sem fechamento/);
    assert.match(blockError("{{#locadores}}{{#locatarios}}x{{/locatarios}}{{/locadores}}")!, /dentro de outro/);
    assert.equal(blockError("{{#locadores}}x{{/locadores}} {{#locatarios}}y{{/locatarios}}"), undefined);
    assert.deepEqual(unknownVariables("{{#locadores}}{{locador.nomee}}{{/locadores}}"), ["locador.nomee"]);
  });

  it("valor de cadastro não cria formatação, quadro de assinaturas nem variável nova", () => {
    assert.equal(cleanValue("# Título\n[[assinaturas]] {{contrato.cidade}} ****x"), "Título assinaturas contrato.cidade *x");
    const r = render("{{a}}", { a: "> aviso\n## falso" }) as { text: string };
    assert.equal(r.text, "aviso ## falso", "sem quebra de linha, não vira seção");
  });

  it("qualificação: pessoa física completa, cônjuge, pessoa jurídica e dados faltando", () => {
    const full = { name: "Ana", document: "123.456.789-09", rg: "1 SSP/SP", nationality: "brasileira", marital_status: "casado", profession: "médica", address: "Rua A, 1", spouse_name: "Beto", spouse_document: "987" };
    assert.equal(
      personValues("locador", full).values["locador.qualificacao"],
      "Ana, brasileira, casado(a) com Beto (CPF 987), médica, portador(a) do RG n.º 1 SSP/SP, inscrito(a) no CPF/MF sob o n.º 123.456.789-09, residente e domiciliado(a) em Rua A, 1",
    );
    const co = personValues("locador", { name: "ACME Ltda", document: "12.345.678/0001-95", address: "Av. B, 2", representative_name: "Carla" });
    assert.match(co.values["locador.qualificacao"]!, /pessoa jurídica inscrita no CNPJ\/MF .* representada por Carla$/);
    const gaps = personValues("locatario", { name: "Zé", document: "1" });
    assert.equal(gaps.values["locatario.qualificacao"], "");
    assert.deepEqual(gaps.incomplete, ["nacionalidade", "estado_civil", "profissao", "rg", "endereco"]);
  });
});

const qualify = (extra: Record<string, unknown> = {}) => ({ nationality: "brasileiro(a)", marital_status: "solteiro", profession: "analista", rg: "11.111.111-1 SSP/SP", address: "Rua das Partes, 10, São Paulo/SP", ...extra });

/** Dois locadores, dois locatários e tudo o que o modelo padrão exige. */
async function fullScenario(c: Client, tag: string) {
  const o1 = (await c.call("POST", "/api/owners", { name: "Alice Locadora", document: `1${tag}1`, ...qualify() })).body.item;
  const o2 = (await c.call("POST", "/api/owners", { name: "Bruno Locador", document: `1${tag}2`, ...qualify() })).body.item;
  const prop = (await c.call("POST", "/api/properties", { name: "Prédio", type: "apartamento", street: "Rua X", number: "1", city: "São Paulo", state: "SP" })).body.item;
  await c.call("PUT", `/api/properties/${prop.id}/owners`, { ownerIds: [o1.id, o2.id] });
  const unit = (await c.call("POST", "/api/units", { property_id: prop.id, identifier: "12", energy_installation: "ENEL-9", water_supply: "SAB-7" })).body.item;
  const t1 = (await c.call("POST", "/api/tenants", { name: "Carla Inquilina", document: `2${tag}1`, ...qualify() })).body.item;
  const t2 = (await c.call("POST", "/api/tenants", { name: "Davi Inquilino", document: `2${tag}2`, ...qualify() })).body.item;
  const lease = (await c.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [t1.id, t2.id], start_date: "2026-09-20", end_date: "2027-09-19", rent_cents: 250000, due_day: 10, signing_city: "São Paulo", witness1_name: "Teste Um", witness1_document: "RG 1" })).body.lease;
  const g = await c.call("POST", `/api/leases/${lease.id}/guarantees`, { kind: "caucao", amount_cents: 750000 });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const company = await c.call("PUT", "/api/settings/company", {
    legal_name: "Ethos Administradora de Imóveis Ltda", cnpj: "00.000.000/0001-00", company_address: "Av. Central, 100", company_city: "São Paulo, SP",
    company_phone: "(11) 3000-0000", company_whatsapp: "(11) 90000-0000", company_email: "contato@ethos.example.com",
  });
  assert.equal(company.status, 200, JSON.stringify(company.body));
  const starter = STARTERS[0]!;
  const tpl = await c.call("POST", "/api/contract-templates", { name: starter.name, type: starter.type, body: starter.body });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
  return { leaseId: lease.id as number, templateId: tpl.body.item.id as number, tenantId: t1.id as number };
}

describe("modelos padrão e dados da empresa", () => {
  it("todos os modelos de partida são aceitos pela validação", async () => {
    const c = await register(base, "ci-st@x.com", "CI ST");
    const list = (await c.call("GET", "/api/contract-starters")).body.items;
    assert.equal(list.length, STARTERS.length);
    for (const s of list) assert.equal((await c.call("POST", "/api/contract-templates", { name: s.name, type: s.type, body: s.body })).status, 201, s.id);
    assert.equal((await c.call("POST", "/api/contract-templates", { name: "x", type: "nao_existe", body: "a" })).status, 400);
    assert.equal((await c.call("POST", "/api/contract-templates", { name: "y", body: "{{#locadores}}a" })).status, 400);
    const vars = (await c.call("GET", "/api/contract-variables")).body;
    assert.ok(vars.variables.length > 60 && vars.blocks.length === 3 && vars.types.length === 8);
  });

  it("dados da empresa: só admin grava, logo precisa ser imagem e fica isolado por organização", async () => {
    const a = await register(base, "ci-co@x.com", "CI CO");
    const b = await register(base, "ci-co2@x.com", "CI CO2");
    assert.equal((await a.call("PUT", "/api/settings/company", { legal_name: "A Ltda", logo_data: PNG })).status, 200);
    assert.equal((await a.call("PUT", "/api/settings/company", { logo_data: "data:image/svg+xml;base64,PHN2Zz4=" })).status, 400);
    assert.equal((await a.call("PUT", "/api/settings/company", { logo_data: "data:image/png;base64," + Buffer.from("não é png").toString("base64") })).status, 400);
    assert.equal((await a.call("PUT", "/api/settings/company", { logo_data: "data:image/png;base64," + "A".repeat(95_000) })).status, 400);
    assert.equal((await a.call("PUT", "/api/settings/company", { company_email: "x" })).status, 400);
    assert.equal((await a.call("PUT", "/api/settings/company", {})).status, 400);
    assert.equal((await b.call("GET", "/api/settings/company")).body.company.legal_name, null);
    const inv = await a.call("POST", "/api/invitations", { email: "ci-col@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${new URL(inv.body.link).searchParams.get("invite")}/accept`, { name: "Col", password: "senha-segura-123" });
    assert.equal((await col.call("GET", "/api/settings/company")).status, 200);
    assert.equal((await col.call("PUT", "/api/settings/company", { legal_name: "hack" })).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/settings/company")).status, 401);
  });
});

describe("documento com várias partes, número e identidade", () => {
  it("modelo padrão com 2 locadores e 2 locatários: qualifica cada um, numera, e guarda a identidade do momento", async () => {
    const c = await register(base, "ci-doc@x.com", "CI DOC");
    const s = await fullScenario(c, "7");

    const prev = await c.call("POST", `/api/leases/${s.leaseId}/preview`, { templateId: s.templateId });
    assert.equal(prev.status, 200, JSON.stringify(prev.body));
    const text: string = prev.body.content;
    assert.equal(text.match(/\*\*LOCADOR\(A\):\*\* /g)!.length, 2);
    assert.equal(text.match(/\*\*LOCATÁRIO\(A\):\*\* /g)!.length, 2);
    for (const name of ["Alice Locadora", "Bruno Locador", "Carla Inquilina", "Davi Inquilino"]) assert.ok(text.includes(name), name);
    assert.ok(text.includes("fins residenciais de Carla Inquilina e Davi Inquilino"));
    assert.ok(text.includes("R$ 2.500,00 (dois mil e quinhentos reais)"));
    assert.ok(text.includes("R$ 7.500,00 (sete mil e quinhentos reais), equivalente a 3 meses"));
    assert.ok(text.includes("é de 12 meses") && text.includes("ENEL-9") && text.includes("SAB-7"));
    assert.ok(text.includes("[[assinaturas]]"));
    assert.doesNotMatch(text, /\{\{/);
    assert.equal(prev.body.number, null);
    assert.deepEqual(prev.body.layout.signers.map((x: { role: string }) => x.role), ["LOCADOR(A)", "LOCADOR(A)", "LOCATÁRIO(A)", "LOCATÁRIO(A)", "ADMINISTRADORA (interveniente)"]);
    assert.equal(prev.body.layout.witnesses[0].name, "Teste Um");

    const year = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date()).slice(0, 4);
    const d1 = (await c.call("POST", `/api/leases/${s.leaseId}/documents`, { templateId: s.templateId })).body.document;
    const d2 = (await c.call("POST", `/api/leases/${s.leaseId}/documents`, { templateId: s.templateId })).body.document;
    assert.deepEqual([d1.number, d2.number], [`ETH-${year}-0001`, `ETH-${year}-0002`], "preview não consome número");

    // Identidade e partes ficam congeladas no documento.
    await c.call("PUT", "/api/settings/company", { legal_name: "Outro Nome Ltda" });
    const stored = (await c.call("GET", `/api/documents/${d1.id}`)).body.document;
    assert.equal(stored.format, 2);
    assert.equal(stored.number, `ETH-${year}-0001`);
    assert.equal(stored.layout.company.legal_name, "Ethos Administradora de Imóveis Ltda");
    assert.equal(stored.layout.type_label, "Locação residencial");

    // Cada organização tem a sua sequência.
    const other = await register(base, "ci-doc2@x.com", "CI DOC2");
    const o = await fullScenario(other, "8");
    assert.equal((await other.call("POST", `/api/leases/${o.leaseId}/documents`, { templateId: o.templateId })).body.document.number, `ETH-${year}-0001`);
    assert.equal((await other.call("GET", `/api/documents/${d1.id}`)).status, 404);

    // Emissões simultâneas não repetem número.
    const many = await Promise.all([1, 2, 3, 4].map(() => c.call("POST", `/api/leases/${s.leaseId}/documents`, { templateId: s.templateId })));
    const numbers = many.map((r) => r.body.document.number).sort();
    assert.deepEqual(numbers, [3, 4, 5, 6].map((n) => `ETH-${year}-000${n}`));
  });

  it("falta de qualificação bloqueia dizendo o campo e a pessoa, sem consumir número; aviso quando dados se juntam", async () => {
    const c = await register(base, "ci-miss@x.com", "CI MISS");
    const s = await fullScenario(c, "9");
    await c.call("PATCH", `/api/tenants/${s.tenantId}`, { rg: null, profession: null });
    const r = await c.call("POST", `/api/leases/${s.leaseId}/documents`, { templateId: s.templateId });
    assert.equal(r.status, 422);
    assert.ok(r.body.missing.includes("locatario.profissao (Carla Inquilina)"), JSON.stringify(r.body.missing));
    assert.ok(r.body.missing.includes("locatario.rg (Carla Inquilina)"));
    assert.match(r.body.error, /\{\{locatario\.rg\}\} \(Carla Inquilina\)/);
    await c.call("PATCH", `/api/tenants/${s.tenantId}`, { rg: "2", profession: "dev" });
    assert.match((await c.call("POST", `/api/leases/${s.leaseId}/documents`, { templateId: s.templateId })).body.document.number, /-0001$/);

    const loose = (await c.call("POST", "/api/contract-templates", { name: "Solto", body: "RG: {{locatario.rg}}" })).body.item;
    const p = await c.call("POST", `/api/leases/${s.leaseId}/preview`, { templateId: loose.id });
    assert.equal(p.status, 200);
    assert.match(p.body.warnings[0], /mais de uma pessoa em "locatarios"/);
  });

  it("fiador da garantia entra no bloco e no quadro de assinaturas", async () => {
    const c = await register(base, "ci-fi@x.com", "CI FI");
    const s = await fullScenario(c, "6");
    await c.call("POST", `/api/leases/${s.leaseId}/guarantees`, { kind: "fiador", details: { name: "Fábio Fiador", document: "555" } });
    const tpl = (await c.call("POST", "/api/contract-templates", { name: "Com fiador", body: "{{#fiadores}}\nFiador: {{fiador.nome}} ({{fiador.documento}})\n{{/fiadores}}\n[[assinaturas]]" })).body.item;
    const p = await c.call("POST", `/api/leases/${s.leaseId}/preview`, { templateId: tpl.id });
    assert.ok(p.body.content.includes("Fiador: Fábio Fiador (555)"));
    assert.ok(p.body.layout.signers.some((x: { role: string; name: string }) => x.role === "FIADOR(A)" && x.name === "Fábio Fiador"));
  });
});
