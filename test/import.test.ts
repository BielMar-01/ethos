import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, register, startServer, tokenFrom } from "./helpers.js";
import { parseMoney } from "../src/importer.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

const owners = [
  { Nome: "Maria Souza", CPF: "123.456.789-09", "E-mail": "maria@x.com", Telefone: "(11) 99999-0001" },
  { Nome: "João Lima", CPF: "98765432100" },
];
const tenants = [{ nome: "Carlos Almeida", documento: "111.222.333-44" }];
const properties = [
  { Nome: "Edifício Aurora", Tipo: "Apartamento", Rua: "Rua das Flores", Número: "100", Cidade: "São Paulo", UF: "SP", Proprietários: "123.456.789-09 | 987.654.321-00" },
  { Nome: "Casa Verde", Tipo: "casa" },
];
const units = [
  { Imóvel: "Edifício Aurora", Unidade: "Apto 101", Quartos: "2", Área: "62 m²", Aluguel: "R$ 2.500,00", Situação: "Disponível" },
  { Imóvel: "edificio aurora", Unidade: "Apto 102", Aluguel: "1800" },
  { Imóvel: "Casa Verde", Unidade: "Casa" },
];

describe("importação em massa", () => {
  it("importa vários tipos de uma vez, resolve vínculos pelo envio e é idempotente", async () => {
    const a = await register(base, "imp@x.com", "Imp");
    const r = await a.call("POST", "/api/import", { sets: { owners, tenants, properties, units } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(
      [r.body.results.owners.created, r.body.results.tenants.created, r.body.results.properties.created, r.body.results.units.created],
      [2, 1, 2, 3],
    );

    const props = (await a.call("GET", "/api/properties")).body.items;
    const aurora = props.find((p: { name: string }) => p.name === "Edifício Aurora");
    assert.equal(aurora.type, "apartamento");
    assert.equal((await a.call("GET", `/api/properties/${aurora.id}/owners`)).body.items.length, 2, "proprietários ligados pelo documento");
    const us = (await a.call("GET", "/api/units")).body.items;
    const u101 = us.find((u: { identifier: string }) => u.identifier === "Apto 101");
    assert.equal(u101.rent_reference_cents, 250000);
    assert.equal(u101.area_m2, 62);
    assert.equal(u101.status, "disponivel");

    const again = await a.call("POST", "/api/import", { sets: { owners, tenants, properties, units } });
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.results.owners.created, again.body.results.units.created], [0, 0], "nada duplica");
    assert.equal(again.body.results.owners.skipped.length, 2);
    assert.equal((await a.call("GET", "/api/owners")).body.items.length, 2);
  });

  it("simulação (dryRun) valida e mostra o resultado sem gravar nada", async () => {
    const a = await register(base, "imp-dry@x.com", "ImpDry");
    const r = await a.call("POST", "/api/import", { dryRun: true, sets: { owners, properties, units } });
    assert.equal(r.status, 200);
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.results.owners.created, 2);
    assert.equal((await a.call("GET", "/api/owners")).body.items.length, 0);
    assert.equal((await a.call("GET", "/api/units")).body.items.length, 0);
  });

  it("tudo ou nada: um erro em qualquer linha impede a gravação e aponta a linha", async () => {
    const a = await register(base, "imp-err@x.com", "ImpErr");
    const bad = [
      { Nome: "Ok Pessoa", CPF: "1" },
      { Nome: "", CPF: "2" },
      { Nome: "Email Ruim", CPF: "3", "E-mail": "nao-e-email" },
    ];
    const r = await a.call("POST", "/api/import", {
      sets: {
        owners: bad,
        properties: [{ Nome: "P", Tipo: "castelo" }],
        units: [{ Imóvel: "Inexistente", Unidade: "1" }, { Imóvel: "P", Unidade: "2", Aluguel: "abc" }],
      },
    });
    assert.equal(r.status, 422);
    const msgs = r.body.errors.map((e: { resource: string; line: number; message: string }) => `${e.resource}:${e.line}:${e.message}`);
    assert.ok(msgs.some((m: string) => /^owners:3:.*nome/.test(m)), msgs.join("\n"));
    assert.ok(msgs.some((m: string) => /^owners:4:.*e-mail/i.test(m)), msgs.join("\n"));
    assert.ok(msgs.some((m: string) => /^properties:2:.*tipo/.test(m)), msgs.join("\n"));
    assert.ok(msgs.some((m: string) => /^units:2:.*Imóvel não encontrado/.test(m)), msgs.join("\n"));
    assert.equal((await a.call("GET", "/api/owners")).body.items.length, 0, "nem a linha boa foi gravada");
  });

  it("proprietário citado que não existe é erro; documentos com máscara diferente contam como o mesmo", async () => {
    const a = await register(base, "imp-doc@x.com", "ImpDoc");
    await a.call("POST", "/api/owners", { name: "Existente", document: "123.456.789-09" });
    const r = await a.call("POST", "/api/import", {
      sets: { owners: [{ nome: "Mesmo", documento: "12345678909" }], properties: [{ nome: "X", tipo: "casa", proprietarios: "000.000.000-00" }] },
    });
    assert.equal(r.status, 422);
    assert.match(r.body.errors[0].message, /Proprietário não encontrado/);
    const ok = await a.call("POST", "/api/import", { sets: { owners: [{ nome: "Mesmo", documento: "12345678909" }] } });
    assert.equal(ok.body.results.owners.skipped[0].reason, "documento já cadastrado");
  });

  it("limites e permissões: vazio, desconhecido, excesso de linhas, anônimo, cliente e isolamento", async () => {
    const a = await register(base, "imp-perm@x.com", "ImpPerm");
    const b = await register(base, "imp-perm-b@x.com", "ImpPermB");
    assert.equal((await a.call("POST", "/api/import", { sets: {} })).status, 400);
    assert.equal((await a.call("POST", "/api/import", { sets: { donos: [{}] } })).status, 400);
    assert.equal((await a.call("POST", "/api/import", { sets: { owners: "x" } })).status, 400);
    const many = Array.from({ length: 2001 }, (_, i) => ({ nome: `P${i}`, documento: String(i) }));
    assert.equal((await a.call("POST", "/api/import", { sets: { owners: many } })).status, 413);
    assert.equal((await new Client(base).call("POST", "/api/import", { sets: { owners } })).status, 401);

    const tenantId = (await a.call("POST", "/api/tenants", { name: "T", document: "9" })).body.item.id;
    const inv = await a.call("POST", "/api/invitations", { email: "imp-inq@x.com", role: "inquilino", tenantId });
    const inq = new Client(base);
    await inq.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { name: "Inq", password: PASSWORD });
    assert.equal((await inq.call("POST", "/api/import", { sets: { owners } })).status, 403, "cliente não importa");

    await a.call("POST", "/api/import", { sets: { owners } });
    assert.equal((await b.call("GET", "/api/owners")).body.items.length, 0, "a outra organização não vê");
    assert.equal((await b.call("POST", "/api/import", { sets: { owners } })).body.results.owners.created, 2, "mesmo documento em outra organização é permitido");
  });

  it("entra no registro de auditoria só quando grava de verdade, e corpos grandes (acima de 100 KB) passam", async () => {
    const a = await register(base, "imp-aud@x.com", "ImpAud");
    const big = Array.from({ length: 1500 }, (_, i) => ({
      nome: `Pessoa com nome razoavelmente comprido número ${i}`,
      documento: `D${i}`,
      email: `pessoa${i}@exemplo.com.br`,
      telefone: "(11) 99999-0000",
    }));
    assert.ok(JSON.stringify(big).length > 100_000);
    await a.call("POST", "/api/import", { dryRun: true, sets: { owners: big } });
    const real = await a.call("POST", "/api/import", { sets: { owners: big } });
    assert.equal(real.status, 200);
    assert.equal(real.body.results.owners.created, 1500);
    await new Promise((ok) => setTimeout(ok, 200));
    const logs = (await a.call("GET", "/api/audit?entity=import")).body.items;
    assert.equal(logs.length, 1, "a simulação não é registrada");
    assert.match(logs[0].summary, /Importou em massa: 1500 proprietário/);
  });

  it("parseMoney entende formatos brasileiros e rejeita lixo", () => {
    assert.equal(parseMoney("R$ 2.500,00"), 250000);
    assert.equal(parseMoney("1500,5"), 150050);
    assert.equal(parseMoney("1500.50"), 150050);
    assert.equal(parseMoney("1.500.000"), 150000000);
    assert.equal(parseMoney("abc"), null);
    assert.equal(parseMoney("-5"), null);
  });
});
