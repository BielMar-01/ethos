import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";
import { formatCep, formatDocument, formatPhone, parseDateBr } from "../src/brFormat.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

const base1 = {
  owners: [{ nome: "Maria Souza", documento: "12345678909", telefone: "11912345678" }],
  tenants: [
    { nome: "Carlos Almeida", documento: "98765432100", telefone: "+55 (11) 3234-5678" },
    { nome: "Ana Lima", documento: "111.222.333-96" },
  ],
  properties: [{ nome: "Edifício Aurora", tipo: "apartamento", cep: "01001000", proprietarios: "123.456.789-09" }],
  units: [
    { imovel: "Edifício Aurora", unidade: "101" },
    { imovel: "Edifício Aurora", unidade: "102" },
  ],
};
const leaseRow = (extra: Record<string, string> = {}) => ({
  imovel: "Edifício Aurora",
  unidade: "101",
  locatarios: "987.654.321-00 | 11122233396",
  inicio: "01/01/2030",
  fim: "31/12/2030",
  aluguel: "R$ 2.500,00",
  dia_vencimento: "10",
  situacao: "vigente",
  ...extra,
});

describe("formatação no servidor", () => {
  it("formata telefone, documento e CEP e entende datas brasileiras", () => {
    assert.equal(formatPhone("11912345678"), "(11) 91234-5678");
    assert.equal(formatPhone("+55 11 3234-5678"), "(11) 3234-5678");
    assert.equal(formatPhone("123"), "123");
    assert.equal(formatDocument("12345678909"), "123.456.789-09");
    assert.equal(formatDocument("12345678000195"), "12.345.678/0001-95");
    assert.equal(formatDocument("ABC-1"), "ABC-1");
    assert.equal(formatCep("01001000"), "01001-000");
    assert.equal(parseDateBr("23/11/2026"), "2026-11-23");
    assert.equal(parseDateBr("2026-11-23"), "2026-11-23");
    assert.equal(parseDateBr("5.3.26"), "2026-03-05");
    assert.equal(parseDateBr("31/02/2026"), null);
    assert.equal(parseDateBr("amanhã"), null);
  });
});

describe("importação de contratos, cobranças e vistorias", () => {
  it("importa tudo de uma vez, formata telefone/documento/CEP e é idempotente", async () => {
    const a = await register(base, "im1@x.com", "Im1");
    const sets = {
      ...base1,
      leases: [leaseRow()],
      charges: [
        { imovel: "Edifício Aurora", unidade: "101", vencimento: "10/06/2030", valor: "2500,00" },
        { imovel: "Edifício Aurora", unidade: "101", tipo: "multa", descricao: "Multa por atraso", vencimento: "15/06/2030", valor: "50" },
      ],
      inspections: [{ imovel: "Edifício Aurora", unidade: "101", tipo: "Entrada", data: "02/01/2030" }],
    };
    const dry = await a.call("POST", "/api/import", { dryRun: true, sets });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.results.leases.created, 1);
    assert.equal((await a.call("GET", "/api/leases")).body.items.length, 0, "simulação não grava");

    const r = await a.call("POST", "/api/import", { sets });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.results.leases.created, r.body.results.charges.created, r.body.results.inspections.created], [1, 2, 1]);

    const owner = (await a.call("GET", "/api/owners")).body.items[0];
    assert.equal(owner.phone, "(11) 91234-5678");
    assert.equal(owner.document, "123.456.789-09");
    const tenants = (await a.call("GET", "/api/tenants")).body.items;
    assert.ok(tenants.some((t: { phone: string | null }) => t.phone === "(11) 3234-5678"));
    assert.equal((await a.call("GET", "/api/properties")).body.items[0].zip, "01001-000");

    const leases = (await a.call("GET", "/api/leases")).body.items;
    assert.equal(leases.length, 1);
    assert.equal(leases[0].status, "vigente");
    assert.equal(leases[0].rent_cents, 250000);
    assert.equal(leases[0].due_day, 10);
    const units = (await a.call("GET", "/api/units")).body.items;
    assert.equal(units.find((u: { identifier: string }) => u.identifier === "101").status, "ocupada");
    const charges = (await a.call("GET", "/api/charges")).body.items;
    assert.equal(charges.length, 2);
    assert.equal(charges.find((c: { kind: string }) => c.kind === "aluguel").description, "Aluguel 06/2030");
    const insp = (await a.call("GET", "/api/inspections")).body.items;
    assert.equal(insp.length, 1);
    assert.equal(insp[0].type, "entrada");
    assert.equal(insp[0].status, "agendada");

    // Reenviar o mesmo: tudo pulado.
    const again = await a.call("POST", "/api/import", { sets });
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.results.leases.created, again.body.results.charges.created, again.body.results.inspections.created], [0, 0, 0]);
    assert.equal(again.body.results.leases.skipped.length, 1);
    assert.equal(again.body.results.charges.skipped.length, 2);
    assert.equal(again.body.results.inspections.skipped.length, 1);
  });

  it("aponta cada erro com a linha e não grava nada (tudo ou nada)", async () => {
    const a = await register(base, "im2@x.com", "Im2");
    const sets = {
      ...base1,
      leases: [
        leaseRow({ locatarios: "000.000.000-00" }),
        leaseRow({ inicio: "31/02/2030" }),
        leaseRow({ fim: "01/01/2029" }),
        leaseRow({ aluguel: "abc" }),
        leaseRow({ situacao: "inventado" }),
        leaseRow({ unidade: "999" }),
        leaseRow({ imovel: "Não existe" }),
        leaseRow({ locatarios: "", situacao: "vigente" }),
        leaseRow({ dia_vencimento: "40" }),
      ],
      charges: [
        { imovel: "Edifício Aurora", unidade: "102", vencimento: "10/06/2030", valor: "100" }, // sem contrato
        { imovel: "Edifício Aurora", unidade: "101", tipo: "xyz", vencimento: "10/06/2030", valor: "100" },
        { imovel: "Edifício Aurora", unidade: "101", tipo: "multa", vencimento: "10/06/2030", valor: "100" }, // sem descrição
      ],
      inspections: [
        { imovel: "Edifício Aurora", unidade: "101", tipo: "outra", data: "02/01/2030" },
        { imovel: "Edifício Aurora", unidade: "101", tipo: "saida", data: "99/99/2030" },
      ],
    };
    const r = await a.call("POST", "/api/import", { sets });
    assert.equal(r.status, 422);
    assert.equal(r.body.errorCount, 14);
    const msgs = r.body.errors.map((e: { resource: string; line: number; message: string }) => `${e.resource}:${e.line}:${e.message}`).join("\n");
    assert.match(msgs, /leases:2:.*Locatário não encontrado/);
    assert.match(msgs, /leases:3:.*início/);
    assert.match(msgs, /leases:4:.*anterior/);
    assert.match(msgs, /leases:5:.*aluguel/);
    assert.match(msgs, /leases:6:.*Situação inválida/);
    assert.match(msgs, /leases:7:.*Unidade não encontrada/);
    assert.match(msgs, /leases:8:.*Imóvel não encontrado/);
    assert.match(msgs, /leases:9:.*ao menos um locatário/);
    assert.match(msgs, /leases:10:.*dia de vencimento/);
    assert.match(msgs, /charges:2:.*não tem contrato/);
    assert.match(msgs, /charges:3:.*Tipo inválido/);
    assert.match(msgs, /charges:4:.*descrição/);
    assert.match(msgs, /inspections:2:.*Tipo inválido/);
    assert.match(msgs, /inspections:3:.*Data inválida/);
    assert.equal((await a.call("GET", "/api/owners")).body.items.length, 0, "nada gravado");
    assert.equal((await a.call("GET", "/api/leases")).body.items.length, 0);
  });

  it("barra contrato vigente sobreposto (também dentro do mesmo envio) e aceita rascunho/encerrado sem checagem de vigência", async () => {
    const a = await register(base, "im3@x.com", "Im3");
    const overlap = await a.call("POST", "/api/import", { sets: { ...base1, leases: [leaseRow(), leaseRow({ inicio: "01/06/2030", fim: "31/12/2031" })] } });
    assert.equal(overlap.status, 422);
    assert.match(overlap.body.errors[0].message, /Já existe contrato vigente/);

    const ok = await a.call("POST", "/api/import", {
      sets: {
        ...base1,
        leases: [leaseRow(), leaseRow({ inicio: "01/06/2031", fim: "31/12/2031", situacao: "" }), leaseRow({ inicio: "01/01/2020", fim: "31/12/2020", situacao: "encerrado" })],
      },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.results.leases.created, 3);
    const statuses = (await a.call("GET", "/api/leases")).body.items.map((l: { status: string }) => l.status).sort();
    assert.deepEqual(statuses, ["encerrado", "rascunho", "vigente"]);
  });

  it("contrato importado alimenta o financeiro: aluguel importado não duplica o gerado e cobrança vai ao contrato do período", async () => {
    const a = await register(base, "im4@x.com", "Im4");
    const sets = {
      ...base1,
      leases: [leaseRow({ inicio: "01/01/2030", fim: "31/12/2030" })],
      charges: [{ imovel: "Edifício Aurora", unidade: "101", vencimento: "10/06/2030", valor: "2.500,00" }],
    };
    assert.equal((await a.call("POST", "/api/import", { sets })).status, 200);
    const gen = await a.call("POST", "/api/charges/generate", { month: "2030-06" });
    assert.equal(gen.body.created, 0, "o aluguel de 06/2030 já veio na importação");
    const list = (await a.call("GET", "/api/charges?month=2030-06")).body.items;
    assert.equal(list.length, 1);
    assert.equal(list[0].amount_cents, 250000);
  });

  it("isolamento: outra organização não enxerga cadastros; anônimo e tipo desconhecido são recusados", async () => {
    const a = await register(base, "im5@x.com", "Im5");
    const b = await register(base, "im5b@x.com", "Im5b");
    assert.equal((await a.call("POST", "/api/import", { sets: { ...base1, leases: [leaseRow()] } })).status, 200);
    // Outra organização não enxerga imóvel/unidade/locatário da primeira.
    const r = await b.call("POST", "/api/import", { sets: { leases: [leaseRow()] } });
    assert.equal(r.status, 422);
    assert.match(r.body.errors[0].message, /Imóvel não encontrado/);
    assert.equal((await new Client(base).call("POST", "/api/import", { sets: { leases: [] } })).status, 401);
    assert.equal((await a.call("POST", "/api/import", { sets: { foo: [{}] } })).status, 400);
  });
});

describe("cadastro de unidade com situação vazia", () => {
  it("usa o padrão do banco ao criar e mantém o valor ao editar (antes dava erro 500)", async () => {
    const a = await register(base, "crudenum@x.com", "CE");
    const p = (await a.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
    const created = await a.call("POST", "/api/units", { property_id: p.id, identifier: "A", area_m2: null, status: null, rent_reference_cents: 185050 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.item.status, "disponivel");
    assert.equal(created.body.item.rent_reference_cents, 185050);
    await a.call("PATCH", `/api/units/${created.body.item.id}`, { status: "manutencao" });
    const edited = await a.call("PATCH", `/api/units/${created.body.item.id}`, { identifier: "A2", status: "" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.item.status, "manutencao");
  });
});
