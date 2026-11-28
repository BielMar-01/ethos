import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { Client, register, startServer } from "./helpers.js";
import { importTemplate, reflowPdf } from "../src/templateImport.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

/** ZIP mínimo (um arquivo, comprimido), para montar um .docx de teste. */
function zip(name: string, content: string): Buffer {
  const data = Buffer.from(content, "utf8");
  const packed = zlib.deflateRawSync(data);
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zlib.crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nm.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nm.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + nm.length, 12);
  end.writeUInt32LE(30 + nm.length + packed.length, 16);
  return Buffer.concat([local, nm, packed, central, nm, end]);
}

const run = (text: string, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (runs: string, extra = "") => `<w:p>${extra ? `<w:pPr>${extra}</w:pPr>` : ""}${runs}</w:p>`;
const docx = (body: string) => zip("word/document.xml", `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);

const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");
const send = (c: Client, path: string, body: Buffer, type = "application/octet-stream") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": type, Cookie: c.cookie }, body: new Uint8Array(body) }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }));

describe("conversão do arquivo de modelo (unidade)", () => {
  it("Word: junta pedaços (inclusive variável partida), mantém negrito, marca títulos e avisa o que se perde", async () => {
    const file = docx(
      p(run("CONTRATO DE ", true) + run("LOCAÇÃO", true)) +
        p(run("1 — DAS PARTES", true)) +
        p(run("LOCATÁRIO:", true) + run(" {{locatario") + run(".nome}}, aluguel &amp; encargos de {{contrato.valor_aluguel}}.")) +
        p(run("Cláusula numerada pelo Word."), '<w:numPr><w:numId w:val="1"/></w:numPr>') +
        p(""),
    );
    const r = await importTemplate(file);
    assert.equal(r.format, "docx");
    assert.equal(r.body, "# CONTRATO DE LOCAÇÃO\n\n## 1 — DAS PARTES\n\n**LOCATÁRIO:** {{locatario.nome}}, aluguel & encargos de {{contrato.valor_aluguel}}.\n\nCláusula numerada pelo Word.");
    assert.deepEqual(r.variables, ["locatario.nome", "contrato.valor_aluguel"]);
    assert.match(r.warnings.join(" "), /numeração automática/);
  });

  it("texto/markdown: tira metadados, ajusta títulos, ignora {{...}} explicativo e avisa falta de variáveis", async () => {
    const r = await importTemplate(Buffer.from("---\ntipo: modelo\n---\n\n# T\n\n### 1 — SEÇÃO\n\nCampos `{{...}}` abaixo.\n", "utf8"));
    assert.equal(r.body, "# T\n\n## 1 — SEÇÃO\n\nCampos (campos entre chaves) abaixo.");
    assert.deepEqual(r.unknown, []);
    assert.match(r.warnings.join(" "), /não tem \{\{variáveis\}\}/);
    assert.deepEqual((await importTemplate(Buffer.from("Olá {{inventada.x}}"))).unknown, ["inventada.x"]);
    // Só as reticências são texto explicativo: o resto nunca é apagado em silêncio.
    assert.equal((await importTemplate(Buffer.from("A {{ ... }} B {{…}} C {{abc}}"))).body, "A (campos entre chaves) B (campos entre chaves) C {{abc}}");
  });

  it("PDF: reagrupa linhas, une título quebrado e remove cabeçalho/rodapé repetido", () => {
    const page = (n: number, text: string) => `Ethos Cabeçalho\n${text}\nPágina ${n} de 3`;
    const blocks = reflowPdf([page(1, "CONTRATO DE LOCAÇÃO\nRESIDENCIAL\n1.1 — Texto que\ncontinua na linha."), page(2, "1.2 — Outra\ncláusula."), page(3, "Fim do texto.")]);
    assert.deepEqual(blocks, ["CONTRATO DE LOCAÇÃO RESIDENCIAL", "1.1 — Texto que continua na linha.", "1.2 — Outra cláusula.", "Fim do texto."]);
  });

  it("recusa o que não é modelo", async () => {
    for (const bad of [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), PDF, Buffer.from("   \n  "), zip("outra/coisa.xml", "x")]) await assert.rejects(importTemplate(bad));
  });
});

async function world(tag: string) {
  const c = await register(base, `lf${tag}@x.com`, `LF ${tag}`);
  const prop = (await c.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
  const unit = (await c.call("POST", "/api/units", { property_id: prop.id, identifier: "1" })).body.item;
  const tenant = (await c.call("POST", "/api/tenants", { name: "T", document: `5${tag}` })).body.item;
  const lease = (await c.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [tenant.id], start_date: "2026-01-01", end_date: "2026-12-31", rent_cents: 1000, due_day: 5 })).body.lease;
  await c.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
  const inv = await c.call("POST", "/api/invitations", { email: `lf${tag}-col@x.com`, role: "colaborador" });
  const col = new Client(base);
  await col.call("POST", `/api/invitations/by-token/${new URL(inv.body.link).searchParams.get("invite")}/accept`, { name: "Col", password: "senha-segura-123" });
  return { c, col, leaseId: lease.id as number };
}

describe("anexos de contrato", () => {
  it("anexa PDF e Word a um contrato vigente, baixa o arquivo idêntico, não duplica e só admin exclui", async () => {
    const w = await world("1");
    const url = `/api/leases/${w.leaseId}/files?kind=contrato&title=${encodeURIComponent("Contrato assinado 2025")}`;
    const word = docx(p(run("assinado")));
    const a = await send(w.col, url, PDF);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal((await send(w.c, url, word)).status, 201);
    assert.equal((await send(w.c, url, PDF)).status, 409, "mesmo arquivo");

    const items = (await w.c.call("GET", `/api/leases/${w.leaseId}/files`)).body.items as { id: number; content_type: string; title: string }[];
    assert.equal(items.length, 2);
    assert.equal((await w.c.call("GET", "/api/leases")).body.items[0].file_count, 2);
    const got = await fetch(`${base}/api/lease-files/${a.body.id}/file`, { headers: { Cookie: w.c.cookie } });
    assert.equal(got.headers.get("content-type"), "application/pdf");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.match(got.headers.get("cache-control")!, /private/);
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(PDF));
    const wordFile = await fetch(`${base}/api/lease-files/${items[0]!.id}/file`, { headers: { Cookie: w.c.cookie } });
    assert.match(wordFile.headers.get("content-disposition")!, /^attachment; filename=".*\.docx"/);

    assert.equal((await w.col.call("DELETE", `/api/lease-files/${a.body.id}`)).status, 403);
    assert.equal((await w.c.call("DELETE", `/api/lease-files/${a.body.id}`)).status, 204);
  });

  it("valida tipo, conteúdo e tamanho, e isola organizações, anônimos e chave de API", async () => {
    const w = await world("2");
    const url = (q = "kind=contrato&title=Doc") => `/api/leases/${w.leaseId}/files?${q}`;
    assert.equal((await send(w.c, url(), Buffer.from("<html><script>x</script>"), "application/pdf")).status, 400);
    assert.equal((await send(w.c, url(), zip("a.txt", "x"))).status, 400, "zip qualquer não é Word");
    assert.equal((await send(w.c, url("kind=x&title=Doc"), PDF)).status, 400);
    assert.equal((await send(w.c, url("kind=contrato&title=a"), PDF)).status, 400);
    assert.equal((await send(w.c, url(), Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]))).status, 413);

    const id = (await send(w.c, url(), PDF)).body.id as number;
    const other = await world("3");
    assert.equal((await send(other.c, url(), PDF)).status, 404);
    assert.equal((await other.c.call("GET", `/api/leases/${w.leaseId}/files`)).status, 404);
    assert.equal((await other.c.call("GET", `/api/lease-files/${id}/file`)).status, 404);
    assert.equal((await other.c.call("DELETE", `/api/lease-files/${id}`)).status, 404);
    assert.equal((await new Client(base).call("GET", `/api/lease-files/${id}/file`)).status, 401);
    const key = (await w.c.call("POST", "/api/api-keys", { name: "k" })).body.token;
    assert.equal((await fetch(`${base}/api/lease-files/${id}/file`, { headers: { Authorization: `Bearer ${key}` } })).status, 403);
  });
});

describe("modelo enviado e modelo padrão", () => {
  it("lê o arquivo sem gravar; existe no máximo um padrão por organização", async () => {
    const w = await world("4");
    const read = await send(w.c, "/api/contract-templates/read-file", docx(p(run("Olá {{locatario.nome}}"))));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.body, "Olá {{locatario.nome}}");
    assert.equal((await w.c.call("GET", "/api/contract-templates")).body.items.length, 0, "nada gravado");
    assert.equal((await send(w.c, "/api/contract-templates/read-file", PDF)).status, 400);
    assert.equal((await send(new Client(base), "/api/contract-templates/read-file", PDF)).status, 401);

    const defaults = async () => ((await w.c.call("GET", "/api/contract-templates")).body.items as { name: string; is_default: boolean }[]).filter((t) => t.is_default).map((t) => t.name);
    const a = (await w.c.call("POST", "/api/contract-templates", { name: "A", body: "a", is_default: true })).body.item;
    assert.equal(a.is_default, true);
    const b = (await w.c.call("POST", "/api/contract-templates", { name: "B", body: "b" })).body.item;
    assert.deepEqual(await defaults(), ["A"]);
    assert.equal((await w.col.call("POST", `/api/contract-templates/${b.id}/default`, {})).status, 200);
    assert.deepEqual(await defaults(), ["B"]);
    await w.c.call("POST", "/api/contract-templates", { name: "C", body: "c", is_default: true });
    assert.deepEqual(await defaults(), ["C"]);
    const other = await world("5");
    assert.equal((await other.c.call("POST", `/api/contract-templates/${b.id}/default`, {})).status, 404);
    assert.deepEqual(await defaults(), ["C"]);
    assert.equal((await w.c.call("POST", `/api/contract-templates/${b.id}/default`, { value: "sim" })).status, 400);
  });
});
