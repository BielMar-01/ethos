import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, register, startServer } from "./helpers.js";
import { ENDPOINTS } from "../src/apiSpec.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

const PAST = "2024-03";

/** Chamada com chave de API (sem cookie). */
async function withKey(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function memberClient(admin: Client, email: string, role: string, extra: Record<string, unknown> = {}) {
  const inv = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = new URL(inv.body.link).searchParams.get("invite");
  const c = new Client(base);
  const r = await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name: "Cliente", password: "senha-segura-123" });
  assert.equal(r.status, 201);
  return c;
}

interface World {
  admin: Client;
  ownerA: number;
  ownerB: number;
  tenantA: number;
  tenantB: number;
  leaseA: number;
  leaseB: number;
  chargeA: number;
  paymentA: number;
  paymentB: number;
}

/**
 * Dois imóveis, cada um com seu proprietário e inquilino, ambos com contrato vigente,
 * cobrança do mês e pagamento — para provar que cada cliente enxerga SÓ o que é dele.
 */
async function world(tag: string): Promise<World> {
  const admin = await register(base, `w${tag}@x.com`, `World ${tag}`);
  const mk = async (suffix: string) => {
    const owner = (await admin.call("POST", "/api/owners", { name: `Dono ${suffix}`, document: `10${suffix}` })).body.item;
    const property = (await admin.call("POST", "/api/properties", { name: `Imóvel ${suffix}`, type: "casa" })).body.item;
    await admin.call("PUT", `/api/properties/${property.id}/owners`, { ownerIds: [owner.id] });
    const unit = (await admin.call("POST", "/api/units", { property_id: property.id, identifier: `U-${suffix}` })).body.item;
    const tenant = (await admin.call("POST", "/api/tenants", { name: `Inquilino ${suffix}`, document: `20${suffix}`, email: `t${suffix}@x.com` })).body.item;
    const lease = (
      await admin.call("POST", "/api/leases", {
        unit_id: unit.id, tenantIds: [tenant.id], start_date: "2024-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5,
      })
    ).body.lease;
    await admin.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
    return { owner: owner.id as number, tenant: tenant.id as number, lease: lease.id as number };
  };
  const a = await mk("A");
  const b = await mk("B");
  await admin.call("POST", "/api/charges/generate", { month: PAST });
  const charges = (await admin.call("GET", `/api/charges?month=${PAST}`)).body.items;
  const chargeOf = (lease: number) => charges.find((c: { lease_id: number }) => c.lease_id === lease);
  const pay = async (lease: number) =>
    (
      await admin.call("POST", "/api/payments", {
        lease_id: lease, received_at: "2024-03-10", amount_cents: 100000, method: "pix",
        allocations: [{ charge_id: chargeOf(lease).id, amount_cents: 100000 }],
      })
    ).body.payment.id as number;
  const paymentA = await pay(a.lease);
  const paymentB = await pay(b.lease);
  await admin.call("POST", "/api/transfers/generate", { period: PAST });
  return {
    admin, ownerA: a.owner, ownerB: b.owner, tenantA: a.tenant, tenantB: b.tenant, leaseA: a.lease, leaseB: b.lease,
    chargeA: chargeOf(a.lease).id, paymentA, paymentB,
  };
}

describe("convite e vínculo do cliente", () => {
  it("exige vínculo válido (da mesma organização) para inquilino e proprietário", async () => {
    const a = await register(base, "lk-a@x.com", "LK A");
    const b = await register(base, "lk-b@x.com", "LK B");
    const foreignTenant = (await b.call("POST", "/api/tenants", { name: "X", document: "1" })).body.item;
    const foreignOwner = (await b.call("POST", "/api/owners", { name: "Y", document: "2" })).body.item;
    const tenant = (await a.call("POST", "/api/tenants", { name: "T", document: "3" })).body.item;

    const bad = (body: Record<string, unknown>) => a.call("POST", "/api/invitations", { email: "novo@x.com", ...body });
    assert.equal((await bad({ role: "inquilino" })).status, 400);
    assert.equal((await bad({ role: "inquilino", tenantId: foreignTenant.id })).status, 400);
    assert.equal((await bad({ role: "proprietario" })).status, 400);
    assert.equal((await bad({ role: "proprietario", ownerId: foreignOwner.id })).status, 400);
    assert.equal((await bad({ role: "inquilino", tenantId: tenant.id })).status, 201);
    // Para papéis internos o vínculo é ignorado.
    assert.equal((await a.call("POST", "/api/invitations", { email: "int@x.com", role: "colaborador", tenantId: tenant.id })).body.invitation.tenant_id, null);
  });

  it("trocar o papel de um membro atualiza ou limpa o vínculo", async () => {
    const a = await register(base, "lk2@x.com", "LK2");
    const tenant = (await a.call("POST", "/api/tenants", { name: "T", document: "1" })).body.item;
    await memberClient(a, "lk2m@x.com", "inquilino", { tenantId: tenant.id });
    const members = async () => (await a.call("GET", "/api/members")).body.members;
    const m = (await members()).find((x: { email: string }) => x.email === "lk2m@x.com");
    assert.equal(m.tenant_id, tenant.id);
    assert.equal(m.linked_name, "T");

    assert.equal((await a.call("PATCH", `/api/members/${m.id}`, { role: "proprietario" })).status, 400, "sem ownerId");
    assert.equal((await a.call("PATCH", `/api/members/${m.id}`, { role: "colaborador" })).status, 200);
    const after = (await members()).find((x: { email: string }) => x.email === "lk2m@x.com");
    assert.equal(after.tenant_id, null);
    assert.equal(after.role, "colaborador");
  });
});

describe("área do cliente — inquilino", () => {
  it("vê só o que é dele e baixa o próprio recibo", async () => {
    const w = await world("t1");
    const tA = await memberClient(w.admin, "tt-a@x.com", "inquilino", { tenantId: w.tenantA });

    assert.deepEqual((await tA.call("GET", "/api/portal/me")).body, { kind: "tenant", linked: true, name: "Inquilino A" });
    const leases = (await tA.call("GET", "/api/portal/tenant/leases")).body.items;
    assert.equal(leases.length, 1);
    assert.equal(leases[0].id, w.leaseA);
    assert.equal(leases[0].property_name, "Imóvel A");

    const charges = (await tA.call("GET", "/api/portal/tenant/charges")).body.items;
    assert.equal(charges.length, 1);
    assert.equal(charges[0].id, w.chargeA);
    assert.equal(charges[0].status, "paga");
    assert.equal((await tA.call("GET", "/api/portal/tenant/charges?status=vencida")).body.items.length, 0);
    assert.equal((await tA.call("GET", "/api/portal/tenant/charges?status=zzz")).status, 400);

    const payments = (await tA.call("GET", "/api/portal/tenant/payments")).body.items;
    assert.equal(payments.length, 1);
    assert.equal(payments[0].id, w.paymentA);
    const receipt = await tA.call("GET", `/api/portal/tenant/payments/${w.paymentA}`);
    assert.match(receipt.body.payment.receipt_content, /Inquilino A/);
    // Recibo do vizinho: 404, não 403 (não revela que existe).
    assert.equal((await tA.call("GET", `/api/portal/tenant/payments/${w.paymentB}`)).status, 404);
    assert.equal((await tA.call("GET", "/api/portal/tenant/payments/abc")).status, 404);
  });

  it("vê os contratos emitidos dele e de mais ninguém", async () => {
    const w = await world("t2");
    const tmpl = (await w.admin.call("POST", "/api/contract-templates", { name: "M", body: "Contrato de {{locatario.nome}}" })).body.item;
    const docA = (await w.admin.call("POST", `/api/leases/${w.leaseA}/documents`, { templateId: tmpl.id })).body.document;
    const docB = (await w.admin.call("POST", `/api/leases/${w.leaseB}/documents`, { templateId: tmpl.id })).body.document;
    const tA = await memberClient(w.admin, "tt2@x.com", "inquilino", { tenantId: w.tenantA });

    const list = (await tA.call("GET", "/api/portal/tenant/documents")).body.items;
    assert.deepEqual(list.map((d: { id: number }) => d.id), [docA.id]);
    assert.equal((await tA.call("GET", `/api/portal/tenant/documents/${docA.id}`)).body.document.content, "Contrato de Inquilino A");
    assert.equal((await tA.call("GET", `/api/portal/tenant/documents/${docB.id}`)).status, 404);
  });

  it("não alcança telas da equipe nem a área do proprietário", async () => {
    const w = await world("t3");
    const t = await memberClient(w.admin, "tt3@x.com", "inquilino", { tenantId: w.tenantA });
    for (const path of ["/api/leases", "/api/charges", "/api/payments", "/api/owners", "/api/members", "/api/transfers", "/api/api-keys", "/api/portal/owner/properties", "/api/portal/owner/transfers"]) {
      assert.equal((await t.call("GET", path)).status, 403, path);
    }
    assert.equal((await t.call("POST", "/api/payments", { lease_id: w.leaseA })).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/portal/tenant/leases")).status, 401);
  });

  it("acesso sem vínculo recebe orientação (409), não dados", async () => {
    const a = await register(base, "unl@x.com", "Unl");
    const { db } = await import("../src/db.js");
    const me = (await a.call("GET", "/api/auth/me")).body;
    await db.query("UPDATE organization_members SET role = 'inquilino' WHERE user_id = $1", [me.user.id]);
    assert.equal((await a.call("GET", "/api/portal/tenant/leases")).status, 409);
    assert.deepEqual((await a.call("GET", "/api/portal/me")).body, { kind: "tenant", linked: false, name: null });
  });
});

describe("área do cliente — proprietário", () => {
  it("vê só os imóveis, unidades e repasses dele, sem documentos do inquilino", async () => {
    const w = await world("o1");
    const oA = await memberClient(w.admin, "oo-a@x.com", "proprietario", { ownerId: w.ownerA });

    assert.deepEqual((await oA.call("GET", "/api/portal/me")).body, { kind: "owner", linked: true, name: "Dono A" });
    const props = (await oA.call("GET", "/api/portal/owner/properties")).body.items;
    assert.deepEqual(props.map((p: { name: string }) => p.name), ["Imóvel A"]);
    assert.equal(props[0].units_total, 1);
    assert.equal(props[0].units_occupied, 1);

    const units = (await oA.call("GET", "/api/portal/owner/units")).body.items;
    assert.equal(units.length, 1);
    assert.equal(units[0].tenant_names, "Inquilino A");
    assert.equal(units[0].rent_cents, 100000);
    assert.doesNotMatch(JSON.stringify(units), /document|20A|email/, "nenhum dado pessoal do inquilino");

    const transfers = (await oA.call("GET", "/api/portal/owner/transfers")).body.items;
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].gross_cents, 100000);
    // Nada do proprietário B aparece, nem endpoints de inquilino/equipe.
    assert.doesNotMatch(JSON.stringify([props, units, transfers]), /Imóvel B|Dono B|Inquilino B/);
    for (const path of ["/api/portal/tenant/leases", "/api/payments", "/api/transfers", "/api/properties"]) {
      assert.equal((await oA.call("GET", path)).status, 403, path);
    }
  });
});

describe("chaves de API", () => {
  it("admin cria; o valor só aparece uma vez; a chave lê somente a própria organização", async () => {
    const a = await register(base, "k1@x.com", "K1");
    const b = await register(base, "k2@x.com", "K2");
    await a.call("POST", "/api/properties", { name: "Imóvel da A", type: "casa" });
    await b.call("POST", "/api/properties", { name: "Imóvel da B", type: "casa" });

    assert.equal((await a.call("POST", "/api/api-keys", { name: "" })).status, 400);
    const created = await a.call("POST", "/api/api-keys", { name: "Integração BI" });
    assert.equal(created.status, 201);
    const token: string = created.body.token;
    assert.match(token, /^ethos_[A-Za-z0-9_-]{40,}$/);
    assert.equal(created.body.item.prefix, token.slice(0, 14));

    const listed = JSON.stringify((await a.call("GET", "/api/api-keys")).body);
    assert.doesNotMatch(listed, new RegExp(token.slice(14)), "a lista nunca expõe o segredo");
    assert.equal((await b.call("GET", "/api/api-keys")).body.items.length, 0);

    const read = await withKey(token, "GET", "/api/properties");
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.items.map((p: { name: string }) => p.name), ["Imóvel da A"]);
    assert.ok((await a.call("GET", "/api/api-keys")).body.items[0].last_used_at, "registra o último uso");
  });

  it("é somente leitura e não administra nada", async () => {
    const a = await register(base, "k3@x.com", "K3");
    const token = (await a.call("POST", "/api/api-keys", { name: "ro" })).body.token;

    for (const [method, path, body] of [
      ["POST", "/api/properties", { name: "x", type: "casa" }],
      ["PATCH", "/api/properties/1", { name: "x" }],
      ["DELETE", "/api/properties/1", undefined],
      ["POST", "/api/invitations", { email: "a@x.com", role: "admin" }],
    ] as const) {
      assert.equal((await withKey(token, method, path, body)).status, 403, `${method} ${path}`);
    }
    // Rotas de administração (mesmo GET) e área do cliente ficam fechadas para chaves.
    for (const path of ["/api/api-keys", "/api/members", "/api/invitations", "/api/portal/tenant/leases", "/api/portal/owner/properties"]) {
      assert.equal((await withKey(token, "GET", path)).status, 403, path);
    }
  });

  it("chave inválida, malformada ou revogada é rejeitada", async () => {
    const a = await register(base, "k4@x.com", "K4");
    const created = (await a.call("POST", "/api/api-keys", { name: "temp" })).body;
    assert.equal((await withKey("ethos_" + "x".repeat(43), "GET", "/api/properties")).status, 401);
    assert.equal((await withKey("ethos_curta", "GET", "/api/properties")).status, 401);
    assert.equal((await withKey(created.token, "GET", "/api/properties")).status, 200);

    assert.equal((await a.call("DELETE", `/api/api-keys/${created.item.id}`)).status, 204);
    assert.equal((await a.call("DELETE", `/api/api-keys/${created.item.id}`)).status, 404);
    assert.equal((await withKey(created.token, "GET", "/api/properties")).status, 401);
  });

  it("só admin gerencia chaves, e uma organização não revoga as da outra", async () => {
    const a = await register(base, "k5@x.com", "K5");
    const b = await register(base, "k6@x.com", "K6");
    const col = await memberClient(a, "k5col@x.com", "colaborador");
    assert.equal((await col.call("POST", "/api/api-keys", { name: "x" })).status, 403);
    assert.equal((await col.call("GET", "/api/api-keys")).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/api-keys")).status, 401);

    const key = (await a.call("POST", "/api/api-keys", { name: "da A" })).body;
    assert.equal((await b.call("DELETE", `/api/api-keys/${key.item.id}`)).status, 404);
    assert.equal((await withKey(key.token, "GET", "/api/properties")).status, 200);
  });
});

describe("documentação da API (OpenAPI)", () => {
  it("é pública e bem formada", async () => {
    const res = await fetch(base + "/api/openapi.json");
    assert.equal(res.status, 200);
    const spec = await res.json();
    assert.equal(spec.openapi, "3.0.3");
    assert.equal(spec.servers[0].url, base);
    assert.ok(spec.components.securitySchemes.ApiKey);
    assert.ok(spec.paths["/api/charges"].get.parameters.some((p: { name: string }) => p.name === "month"));
    assert.ok(spec.paths["/api/leases/{id}"].get.parameters.some((p: { in: string }) => p.in === "path"));
    assert.equal(Object.keys(spec.paths).length > 20, true);
  });

  it("todo endpoint documentado existe e o aviso de acesso por chave é verdadeiro", async () => {
    const a = await register(base, "doc@x.com", "Doc");
    const token = (await a.call("POST", "/api/api-keys", { name: "doc" })).body.token;

    for (const e of ENDPOINTS) {
      // Usa os parâmetros de exemplo publicados na documentação (valida os exemplos também).
      const qs = e.query?.length ? "?" + e.query.map((q) => `${q.name}=${encodeURIComponent(q.example)}`).join("&") : "";
      const path = e.path.replace(/\{\w+\}/g, "1") + qs;
      const body = e.method === "get" ? undefined : {};
      const asAdmin = await a.call(e.method.toUpperCase(), path, body);
      assert.notEqual(asAdmin.body?.error, "Rota não encontrada", `${e.method} ${e.path} não existe`);
      assert.ok(asAdmin.status < 500, `${e.method} ${e.path} → ${asAdmin.status}`);

      if (e.method === "get") {
        const viaKey = await withKey(token, "GET", path);
        if (e.apiKey) {
          assert.ok([200, 404].includes(viaKey.status), `GET ${e.path} deveria aceitar chave (veio ${viaKey.status})`);
        } else {
          assert.equal(viaKey.status, 403, `GET ${e.path} não deveria aceitar chave`);
        }
      }
    }
  });
});
