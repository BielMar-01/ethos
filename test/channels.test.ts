import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PASSWORD, register, startServer, type Client } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

/** Espera (até 1,5 s) uma condição que depende de envio em segundo plano. */
async function until(cond: () => boolean | Promise<boolean>, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

async function me(c: Client) {
  const r = (await c.call("GET", "/api/auth/me")).body;
  return { userId: r.user.id as number, orgId: r.organization.id as number, email: r.user.email as string };
}

describe("canais de aviso (e-mail, WhatsApp, push)", () => {
  it("e-mail segue a preferência da categoria e não repete lembrete com a mesma chave", async () => {
    const { memoryMailer } = await import("../src/mailer.js");
    const { notify } = await import("../src/notifications.js");
    const a = await register(base, "canal1@x.com", "C1");
    const { userId, orgId, email } = await me(a);
    const count = () => memoryMailer.outbox.filter((m) => m.to === email && m.subject === "Boleto vence amanhã").length;

    await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Boleto vence amanhã", body: "R$ 100,00", dedupeKey: "k1" });
    assert.ok(await until(() => count() === 1));
    const mail = memoryMailer.outbox.find((m) => m.to === email && m.subject === "Boleto vence amanhã")!;
    assert.match(mail.text, /R\$ 100,00/);
    assert.match(mail.text, /http:\/\/app\.test\//);

    await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Boleto vence amanhã", dedupeKey: "k1" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(count(), 1, "mesma dedupe_key: um e-mail só");

    // Desliga o e-mail da categoria: o sino continua e nada sai.
    assert.equal((await a.call("PUT", "/api/notifications/preferences", { category: "financeiro", email: false })).status, 204);
    await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Boleto vence amanhã", dedupeKey: "k2" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(count(), 1);
    const prefs = (await a.call("GET", "/api/notifications/preferences")).body;
    const f = prefs.items.find((p: { category: string }) => p.category === "financeiro");
    assert.deepEqual([f.in_app, f.email, f.whatsapp, f.push], [true, false, true, true]);
    assert.equal((await a.call("PUT", "/api/notifications/preferences", { category: "financeiro" })).status, 400, "precisa de algum canal");

    // Sino desligado, e-mail ligado: o aviso ainda sai por e-mail, sem repetir.
    await a.call("PUT", "/api/notifications/preferences", { category: "contrato", in_app: false });
    await notify(orgId, [userId], { category: "contrato", kind: "x", title: "Contrato termina", dedupeKey: "c1" });
    await notify(orgId, [userId], { category: "contrato", kind: "x", title: "Contrato termina", dedupeKey: "c1" });
    assert.ok(await until(() => memoryMailer.outbox.filter((m) => m.to === email && m.subject === "Contrato termina").length === 1));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(memoryMailer.outbox.filter((m) => m.to === email && m.subject === "Contrato termina").length, 1);
    assert.equal((await a.call("GET", "/api/notifications")).body.items.filter((n: { title: string }) => n.title === "Contrato termina").length, 0);
  });

  it("provedor Resend: chama a API com a chave e o remetente; erro vira falso, nunca exceção", async () => {
    const { ResendMailer } = await import("../src/mailer.js");
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new ResendMailer("re_chave", "Ethos <avisos@x.com>", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as never);
    await ok.send({ to: "a@x.com", subject: "Oi", text: "Texto" });
    assert.equal(calls[0]!.url, "https://api.resend.com/emails");
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer re_chave");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { from: "Ethos <avisos@x.com>", to: ["a@x.com"], subject: "Oi", text: "Texto" });
    const bad = new ResendMailer("k", "f", (async () => new Response("no", { status: 422 })) as never);
    await assert.rejects(bad.send({ to: "a@x.com", subject: "s", text: "t" }), /HTTP 422/);
  });

  it("WhatsApp: exige telefone e consentimento; usa o modelo aprovado; revogar para o envio", async () => {
    process.env.WHATSAPP_TEST = "1";
    process.env.WHATSAPP_PHONE_ID = "123";
    process.env.WHATSAPP_TOKEN = "tok";
    process.env.WHATSAPP_TEMPLATE = "aviso_ethos";
    const { setWhatsAppFetch, toE164 } = await import("../src/channels.js");
    const { notify } = await import("../src/notifications.js");
    const sent: { url: string; body: any }[] = [];
    setWhatsAppFetch((async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as never);
    try {
      assert.equal(toE164("(11) 91234-5678"), "5511912345678");
      assert.equal(toE164("+55 11 91234-5678"), "5511912345678");
      assert.equal(toE164("123"), null);

      const a = await register(base, "canal2@x.com", "C2");
      const { userId, orgId } = await me(a);
      assert.equal((await a.call("PUT", "/api/notifications/whatsapp-consent", { opt_in: true })).status, 409, "sem telefone");
      await a.call("PUT", "/api/profile", { phone: "11912345678" });
      assert.equal((await a.call("PUT", "/api/notifications/whatsapp-consent", { opt_in: "sim" })).status, 400);

      await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Sem consentimento" });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(sent.length, 0, "sem consentimento nada sai");

      assert.equal((await a.call("PUT", "/api/notifications/whatsapp-consent", { opt_in: true })).status, 204);
      assert.equal((await a.call("GET", "/api/notifications/preferences")).body.whatsapp_opt_in, true);
      await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Boleto vence", body: "Amanhã" });
      assert.ok(await until(() => sent.length === 1));
      assert.equal(sent[0]!.url, "https://graph.facebook.com/v21.0/123/messages");
      assert.equal(sent[0]!.body.to, "5511912345678");
      assert.equal(sent[0]!.body.template.name, "aviso_ethos");
      assert.match(sent[0]!.body.template.components[0].parameters[0].text, /Boleto vence — Amanhã/);

      await a.call("PUT", "/api/notifications/preferences", { category: "financeiro", whatsapp: false });
      await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Outro" });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(sent.length, 1, "categoria sem WhatsApp");

      await a.call("PUT", "/api/notifications/preferences", { category: "financeiro", whatsapp: true });
      assert.equal((await a.call("PUT", "/api/notifications/whatsapp-consent", { opt_in: false })).status, 204);
      await notify(orgId, [userId], { category: "financeiro", kind: "x", title: "Depois de revogar" });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(sent.length, 1, "consentimento revogado");
    } finally {
      delete process.env.WHATSAPP_TEST;
      setWhatsAppFetch(fetch);
    }
  });

  it("push: valida a inscrição, envia o aviso e remove inscrição expirada (410)", async () => {
    const { setPushSender } = await import("../src/channels.js");
    const { notify } = await import("../src/notifications.js");
    const { db } = await import("../src/db.js");
    const delivered: { endpoint: string; payload: any }[] = [];
    let expired = false;
    setPushSender(async (sub, payload) => {
      if (expired) throw Object.assign(new Error("gone"), { statusCode: 410 });
      delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    });
    const a = await register(base, "canal3@x.com", "C3");
    const { userId, orgId } = await me(a);
    const sub = { endpoint: "https://push.example.com/abc123456789", keys: { p256dh: "p256-chave", auth: "auth-chave" } };
    assert.equal((await a.call("POST", "/api/push/subscribe", { endpoint: "http://inseguro", keys: sub.keys })).status, 400);
    assert.equal((await a.call("POST", "/api/push/subscribe", sub)).status, 204);
    assert.equal((await a.call("POST", "/api/push/subscribe", sub)).status, 204, "reinscrever não duplica");
    assert.equal((await db.query("SELECT 1 FROM push_subscriptions WHERE user_id = $1", [userId])).length, 1);

    await notify(orgId, [userId], { category: "comunicado", kind: "x", title: "Aviso novo", body: "Leia" });
    assert.ok(await until(() => delivered.length === 1));
    assert.deepEqual(delivered[0]!.payload, { title: "Aviso novo", body: "Leia", url: "/" });

    expired = true;
    await notify(orgId, [userId], { category: "comunicado", kind: "x", title: "Outro aviso" });
    assert.ok(await until(async () => (await db.query("SELECT 1 FROM push_subscriptions WHERE user_id = $1", [userId])).length === 0), 2000);

    assert.equal((await a.call("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint })).status, 204);
    assert.equal((await new (await import("./helpers.js")).Client(base).call("POST", "/api/push/subscribe", sub)).status, 401);
    const cfg = (await a.call("GET", "/api/push/config")).body;
    assert.equal(cfg.enabled, false, "sem VAPID configurado a tela avisa");
    assert.ok(PASSWORD);
  });
});
