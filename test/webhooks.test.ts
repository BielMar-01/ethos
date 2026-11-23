import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client, PASSWORD, register, startServer, tokenFrom } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
let receiver: http.Server;
let hookUrl: string;
interface Hit { headers: http.IncomingHttpHeaders; body: string }
let hits: Hit[] = [];
let respond: (n: number) => number = () => 200;

before(async () => {
  process.env.INTEGRATIONS_SECRET = "segredo-de-teste-com-mais-de-32-caracteres";
  process.env.ETHOS_ALLOW_PRIVATE_WEBHOOKS = "1"; // o receptor de teste roda em 127.0.0.1
  process.env.ETHOS_WEBHOOK_BACKOFF_MS = "5";
  ({ base, close } = await startServer());
  receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ headers: req.headers, body });
      res.statusCode = respond(hits.length);
      res.end("ok");
    });
  });
  await new Promise<void>((ok) => receiver.listen(0, "127.0.0.1", ok));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});
after(async () => {
  receiver.close();
  delete process.env.ETHOS_ALLOW_PRIVATE_WEBHOOKS;
  await close();
});
beforeEach(() => {
  hits = [];
  respond = () => 200;
});
afterEach(() => {
  process.env.ETHOS_ALLOW_PRIVATE_WEBHOOKS = "1";
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
};
const verify = (hit: Hit, secret: string) => {
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(String(hit.headers["x-ethos-signature"]))!;
  const expected = crypto.createHmac("sha256", secret).update(`${m[1]}.${hit.body}`).digest("hex");
  return m[2] === expected;
};

async function newHook(c: Client, events: string[] = ["*"], name = "n8n") {
  const r = await c.call("POST", "/api/webhooks", { name, url: hookUrl, events });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { item: { id: number }; secret: string };
}

describe("webhooks de saída", () => {
  it("entrega o evento assinado (HMAC) com autor e dados do registro", async () => {
    const a = await register(base, "wh@x.com", "Wh");
    const hook = await newHook(a, ["owner.created"]);
    assert.match(hook.secret, /^whsec_[0-9a-f]{48}$/);
    await a.call("POST", "/api/owners", { name: "Maria Hook", document: "1" });
    await waitFor(() => hits.length > 0);
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.headers["x-ethos-event"], "owner.created");
    assert.ok(verify(hit, hook.secret), "assinatura confere com o segredo");
    assert.ok(!verify(hit, "outro-segredo"), "e não com outro");
    const body = JSON.parse(hit.body);
    assert.equal(body.event, "owner.created");
    assert.equal(body.actor.role, "admin");
    assert.equal(body.data.item.name, "Maria Hook");
    assert.match(body.id, /^[0-9a-f-]{36}$/);
  });

  it("só envia os eventos assinados; eventos sensíveis (senha, convite, chave de API) nunca saem", async () => {
    const a = await register(base, "wh-filter@x.com", "WhFilter");
    await newHook(a, ["*"]);
    const inv = await a.call("POST", "/api/invitations", { email: "col-wh@x.com", role: "colaborador" });
    const c = new Client(base);
    const acc = await c.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { name: "Col", password: PASSWORD });
    await a.call("POST", `/api/members/${acc.body.user.id}/password-reset`, { mode: "password", password: "Nova-senha-123" });
    await a.call("POST", "/api/api-keys", { name: "k" });
    await a.call("POST", "/api/tenants", { name: "Inq", document: "9" });
    await waitFor(() => hits.length > 0);
    await new Promise((r) => setTimeout(r, 150));
    const events = hits.map((h) => h.headers["x-ethos-event"]);
    assert.deepEqual(events, ["tenant.created"], "só o cadastro de negócio saiu");
    assert.ok(!hits.some((h) => /Nova-senha|ethos_/.test(h.body)));
  });

  it("eventos de negócio nomeados: pagamento, status do contrato e comunicado", async () => {
    const a = await register(base, "wh-biz@x.com", "WhBiz");
    await newHook(a, ["lease.status_changed", "payment.received", "announcement.published"]);
    const prop = (await a.call("POST", "/api/properties", { name: "P", type: "casa" })).body.item;
    const unit = (await a.call("POST", "/api/units", { property_id: prop.id, identifier: "1" })).body.item;
    const ten = (await a.call("POST", "/api/tenants", { name: "T", document: "5" })).body.item;
    const lease = (await a.call("POST", "/api/leases", { unit_id: unit.id, tenantIds: [ten.id], start_date: "2026-01-01", end_date: "2030-12-31", rent_cents: 100000, due_day: 5 })).body.lease;
    await a.call("POST", `/api/leases/${lease.id}/status`, { status: "vigente" });
    const ann = (await a.call("POST", "/api/announcements", { title: "Aviso", body: "x", audience: "todos" })).body;
    await a.call("POST", `/api/announcements/${ann.id}/publish`);
    await waitFor(() => hits.length >= 2);
    const names = hits.map((h) => h.headers["x-ethos-event"]).sort();
    assert.deepEqual(names, ["announcement.published", "lease.status_changed"]);
    assert.equal(JSON.parse(hits.find((h) => h.headers["x-ethos-event"] === "lease.status_changed")!.body).data.status, "vigente");
  });

  it("tenta de novo em erro 5xx (até 3 vezes) e não repete erro 4xx", async () => {
    const a = await register(base, "wh-retry@x.com", "WhRetry");
    const hook = await newHook(a, ["*"]);
    respond = (n) => (n < 3 ? 500 : 200);
    const r = await a.call("POST", `/api/webhooks/${hook.item.id}/test`);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.attempts, 3);
    hits = [];
    respond = () => 400;
    const bad = await a.call("POST", `/api/webhooks/${hook.item.id}/test`);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.attempts, 1, "4xx não se repete");
    assert.match(bad.body.error, /HTTP 400/);
    const log = (await a.call("GET", `/api/webhooks/${hook.item.id}/deliveries`)).body.items;
    assert.deepEqual(log.map((d: { status: string }) => d.status), ["error", "ok"]);
    const list = (await a.call("GET", "/api/webhooks")).body.items[0];
    assert.equal(list.last_status, "error");
  });

  it("não segue redirecionamentos e avisa timeout/erro de rede em português", async () => {
    const a = await register(base, "wh-redir@x.com", "WhRedir");
    const hook = await newHook(a);
    respond = () => 302;
    const r = await a.call("POST", `/api/webhooks/${hook.item.id}/test`);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /redirecionamento/);
  });

  it("bloqueia endereços internos e http quando a proteção está ligada", async () => {
    const a = await register(base, "wh-ssrf@x.com", "WhSsrf");
    delete process.env.ETHOS_ALLOW_PRIVATE_WEBHOOKS;
    for (const url of ["http://exemplo.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://user:pw@exemplo.com/x", "ftp://x.com", "não é url"]) {
      const r = await a.call("POST", "/api/webhooks", { name: "x", url, events: ["*"] });
      assert.equal(r.status, 400, url);
      assert.ok(r.body.error, url);
    }
  });

  it("segredo nunca volta na listagem; rotacionar troca a assinatura; só admin; isolado por organização", async () => {
    const a = await register(base, "wh-sec@x.com", "WhSec");
    const b = await register(base, "wh-sec-b@x.com", "WhSecB");
    const hook = await newHook(a, ["*"]);
    const list = JSON.stringify((await a.call("GET", "/api/webhooks")).body);
    assert.ok(!list.includes(hook.secret) && !list.includes("secret_enc"));
    const rot = (await a.call("POST", `/api/webhooks/${hook.item.id}/rotate-secret`)).body.secret;
    assert.notEqual(rot, hook.secret);
    await a.call("POST", `/api/webhooks/${hook.item.id}/test`);
    assert.ok(verify(hits.at(-1)!, rot) && !verify(hits.at(-1)!, hook.secret));

    assert.equal((await b.call("PATCH", `/api/webhooks/${hook.item.id}`, { name: "invasor" })).status, 404);
    assert.equal((await b.call("DELETE", `/api/webhooks/${hook.item.id}`)).status, 404);
    assert.equal((await b.call("POST", `/api/webhooks/${hook.item.id}/test`)).status, 404);
    assert.equal((await b.call("GET", `/api/webhooks/${hook.item.id}/deliveries`)).body.items.length, 0);

    const inv = await a.call("POST", "/api/invitations", { email: "col-sec@x.com", role: "colaborador" });
    const col = new Client(base);
    await col.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { name: "C", password: PASSWORD });
    assert.equal((await col.call("GET", "/api/webhooks")).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/webhooks")).status, 401);
  });

  it("valida nome, eventos e limite; pausar e excluir funcionam", async () => {
    const a = await register(base, "wh-val@x.com", "WhVal");
    assert.equal((await a.call("POST", "/api/webhooks", { name: "", url: hookUrl, events: ["*"] })).status, 400);
    assert.equal((await a.call("POST", "/api/webhooks", { name: "x", url: hookUrl, events: [] })).status, 400);
    assert.equal((await a.call("POST", "/api/webhooks", { name: "x", url: hookUrl, events: ["nao.existe"] })).status, 400);
    const hook = await newHook(a, ["owner.created"]);
    await a.call("PATCH", `/api/webhooks/${hook.item.id}`, { enabled: false });
    await a.call("POST", "/api/owners", { name: "X", document: "77" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hits.length, 0, "pausado não recebe");
    assert.equal((await a.call("DELETE", `/api/webhooks/${hook.item.id}`)).status, 204);
    for (let i = 0; i < 10; i++) await newHook(a, ["*"], `h${i}`);
    assert.equal((await a.call("POST", "/api/webhooks", { name: "extra", url: hookUrl, events: ["*"] })).status, 409);
    assert.ok((await a.call("GET", "/api/webhooks/events")).body.events.length > 10);
  });

  it("sem INTEGRATIONS_SECRET não cria webhook (falha clara, nada guardado sem cifrar)", async () => {
    const a = await register(base, "wh-nosecret@x.com", "WhNoSecret");
    const saved = process.env.INTEGRATIONS_SECRET;
    delete process.env.INTEGRATIONS_SECRET;
    const r = await a.call("POST", "/api/webhooks", { name: "x", url: hookUrl, events: ["*"] });
    process.env.INTEGRATIONS_SECRET = saved;
    assert.equal(r.status, 409);
    assert.match(r.body.error, /INTEGRATIONS_SECRET/);
    assert.equal((await a.call("GET", "/api/webhooks")).body.items.length, 0);
  });
});
