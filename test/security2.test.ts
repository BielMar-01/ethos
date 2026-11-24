import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, memoryProvider, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  process.env.INTEGRATIONS_SECRET = "segredo-de-teste-com-mais-de-32-caracteres";
  ({ base, close } = await startServer());
});
after(async () => close());

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

/** Login com cabeçalhos livres (User-Agent, país). Devolve o cliente já com o cookie. */
async function loginWith(email: string, headers: Record<string, string> = {}, password = PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ email, password }) });
  const c = new Client(base);
  const set = res.headers.get("set-cookie");
  if (set) c.cookie = set.split(";")[0]!;
  const text = await res.text();
  return { c, status: res.status, body: text ? JSON.parse(text) : null };
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 1500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

describe("política de senha", () => {
  it("recusa senhas comuns, iguais ao e-mail e vazadas (k-anonimato); libera se o serviço cair", async () => {
    const { setPwnedFetch } = await import("../src/security.js");
    const reg = (email: string, password: string) => new Client(base).call("POST", "/api/auth/register", { name: "N", email, password });
    assert.equal((await reg("pol1@x.com", "12345678")).status, 400);
    assert.equal((await reg("pol1@x.com", "aaaaaaaaaa")).status, 400);
    assert.equal((await reg("pol-igual@x.com", "pol-igual@x.com")).status, 400);

    const leaked = "Senha-Vazada-123";
    const sha1 = crypto.createHash("sha1").update(leaked).digest("hex").toUpperCase();
    const seen: string[] = [];
    setPwnedFetch((async (url: string) => {
      seen.push(url);
      return new Response(`0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:42\r\n`, { status: 200 });
    }) as never);
    try {
      const bad = await reg("pol2@x.com", leaked);
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /vazamentos/);
      assert.deepEqual(seen, [`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`], "só o prefixo de 5 caracteres sai do servidor");
      assert.equal((await reg("pol3@x.com", "outra-senha-forte-9")).status, 201);
      // A troca de senha e o reset passam pela mesma regra.
      const a = await register(base, "pol4@x.com", "P4");
      const change = await a.call("POST", "/api/profile/password", { current_password: PASSWORD, new_password: leaked });
      assert.equal(change.status, 400);
      setPwnedFetch((async () => {
        throw new Error("sem rede");
      }) as never);
      assert.equal((await a.call("POST", "/api/profile/password", { current_password: PASSWORD, new_password: leaked })).status, 204, "serviço fora do ar não impede");
    } finally {
      setPwnedFetch(null);
    }
  });
});

describe("alertas de segurança", () => {
  it("aparelho novo gera aviso por e-mail e no sino; o mesmo aparelho não; troca de senha avisa", async () => {
    const { memoryMailer } = await import("../src/mailer.js");
    const a = await register(base, "alerta1@x.com", "A1"); // primeiro aparelho: sem aviso
    const mails = () => memoryMailer.outbox.filter((m) => m.to === "alerta1@x.com").map((m) => m.subject);
    await loginWith("alerta1@x.com");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!mails().includes("Ethos: Novo acesso à sua conta"), "mesmo aparelho");

    const w = await loginWith("alerta1@x.com", { "User-Agent": CHROME_WIN });
    assert.equal(w.status, 200);
    assert.ok(await until(() => mails().includes("Ethos: Novo acesso à sua conta")));
    const note = (await w.c.call("GET", "/api/notifications")).body.items.find((n: { category: string }) => n.category === "seguranca");
    assert.match(note.body, /Chrome em Windows/);

    const before = mails().length;
    await loginWith("alerta1@x.com", { "User-Agent": CHROME_WIN });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mails().length, before, "aparelho já conhecido");

    await a.call("POST", "/api/profile/password", { current_password: PASSWORD, new_password: "nova-senha-forte-77" });
    assert.ok(await until(() => mails().includes("Ethos: Sua senha foi alterada")));
  });

  it("registro de segurança do usuário lista logins, falhas e mudanças", async () => {
    const a = await register(base, "alerta2@x.com", "A2");
    await loginWith("alerta2@x.com", {}, "senha-errada-123");
    await a.call("POST", "/api/profile/password", { current_password: PASSWORD, new_password: "nova-senha-forte-88" });
    const log = (await a.call("GET", "/api/profile/security-log")).body.items as { summary: string; ok: boolean; device: string }[];
    const text = log.map((l) => l.summary).join("|");
    assert.match(text, /Tentativa de login com senha incorreta/);
    assert.match(text, /Alterou a própria senha/);
    assert.equal(log.find((l) => /incorreta/.test(l.summary))!.ok, false);
    assert.equal((await new Client(base).call("GET", "/api/profile/security-log")).status, 401);
  });
});

describe("país permitido e inatividade", () => {
  it("bloqueia o login de fora dos países autorizados e não deixa a pessoa se trancar", async () => {
    const a = await register(base, "geo1@x.com", "G1");
    const put = (countries: string, country?: string) =>
      fetch(`${base}/api/profile/security`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: a.cookie, ...(country ? { "x-vercel-ip-country": country } : {}) }, body: JSON.stringify({ allowed_countries: countries }) });
    assert.equal((await put("Brasil")).status, 400);
    assert.equal((await put("PT", "BR")).status, 409, "bloquearia o próprio acesso");
    assert.equal((await put("br, pt", "BR")).status, 200);
    assert.equal((await a.call("GET", "/api/profile/security")).body.allowed_countries, "BR,PT");

    assert.equal((await loginWith("geo1@x.com", { "x-vercel-ip-country": "US" })).status, 403);
    assert.equal((await loginWith("geo1@x.com", { "x-vercel-ip-country": "BR" })).status, 200);
    assert.equal((await loginWith("geo1@x.com")).status, 200, "sem cabeçalho do proxy não há como saber");
    assert.equal((await put("", "BR")).status, 200);
    assert.equal((await loginWith("geo1@x.com", { "x-vercel-ip-country": "US" })).status, 200);
  });

  it("encerra a sessão parada além do tempo da organização (só admin configura)", async () => {
    const { db } = await import("../src/db.js");
    const a = await register(base, "idle1@x.com", "I1");
    assert.equal((await a.call("GET", "/api/settings/security")).body.session_idle_minutes, null);
    assert.equal((await a.call("PUT", "/api/settings/security", { session_idle_minutes: 5 })).status, 400);
    assert.equal((await a.call("PUT", "/api/settings/security", { session_idle_minutes: 30 })).status, 200);
    assert.equal((await a.call("GET", "/api/auth/me")).body.user.email, "idle1@x.com");
    await db.query("UPDATE sessions SET last_seen_at = now() - interval '45 minutes' WHERE user_id = (SELECT id FROM users WHERE email = 'idle1@x.com')");
    assert.equal((await a.call("GET", "/api/auth/me")).body.user, null, "ficou parada 45 min com limite de 30");
    assert.equal((await loginWith("idle1@x.com")).status, 200, "entrando de novo funciona");

    const b = await register(base, "idle2@x.com", "I2");
    await b.call("PUT", "/api/settings/security", { session_idle_minutes: 15 });
    await b.call("PUT", "/api/settings/security", { session_idle_minutes: null });
    assert.equal((await b.call("GET", "/api/settings/security")).body.session_idle_minutes, null);
  });
});

describe("troca de e-mail: cancelar", () => {
  it("cancelar volta o provedor ao e-mail do app e o link antigo deixa de valer", async () => {
    const mem = await memoryProvider();
    const a = await register(base, "cancel1@x.com", "CA1");
    await a.call("POST", "/api/profile/email", { email: "cancel1-novo@x.com", password: PASSWORD });
    assert.equal((await a.call("GET", "/api/profile")).body.user.pending_email, "cancel1-novo@x.com");
    assert.equal((await a.call("DELETE", "/api/profile/email")).body.user.pending_email, null);
    assert.equal((await a.call("DELETE", "/api/profile/email")).status, 404);

    // Link antigo clicado depois de cancelar: o provedor já voltou, nada muda.
    const link = mem.sentEmailChanges.find((m) => m.email === "cancel1-novo@x.com")!.link;
    const r = await new Client(base).call("POST", "/api/auth/email-confirmed", { accessToken: mem.clickLink(link) });
    assert.equal(r.status, 200);
    assert.equal(r.body.email, "cancel1@x.com");
    assert.equal((await loginWith("cancel1@x.com")).status, 200, "o e-mail antigo continua valendo");
    assert.equal((await loginWith("cancel1-novo@x.com")).status, 401);

    // Já clicou no link (o provedor trocou) e só então cancelou: o cancelamento desfaz no provedor.
    const b = await register(base, "cancel2@x.com", "CA2");
    await b.call("POST", "/api/profile/email", { email: "cancel2-novo@x.com", password: PASSWORD });
    mem.clickLink(mem.sentEmailChanges.find((m) => m.email === "cancel2-novo@x.com")!.link);
    assert.equal((await b.call("DELETE", "/api/profile/email")).status, 200);
    assert.equal((await loginWith("cancel2-novo@x.com")).status, 401, "voltou ao e-mail antigo");
    assert.equal((await loginWith("cancel2@x.com")).status, 200);
  });
});

describe("passkeys e login social", () => {
  it("opções exigem senha, desafios são de uso único e passkey desconhecida é recusada", async () => {
    const a = await register(base, "pk1@x.com", "PK1");
    assert.equal((await a.call("POST", "/api/profile/passkeys/options", {})).status, 400);
    assert.equal((await a.call("POST", "/api/profile/passkeys/options", { password: "errada-errada" })).status, 403);
    const opt = await a.call("POST", "/api/profile/passkeys/options", { password: PASSWORD });
    assert.equal(opt.status, 200, JSON.stringify(opt.body));
    assert.ok(opt.body.options.challenge && opt.body.token);
    assert.equal(opt.body.options.rp.id, "app.test");
    assert.equal((await a.call("POST", "/api/profile/passkeys/verify", { token: opt.body.token, response: { id: "x", rawId: "x", type: "public-key", response: {} } })).status, 400);
    assert.equal((await a.call("POST", "/api/profile/passkeys/verify", { token: opt.body.token, response: {} })).status, 400, "desafio já consumido");
    assert.deepEqual((await a.call("GET", "/api/profile/passkeys")).body.items, []);
    assert.equal((await a.call("DELETE", "/api/profile/passkeys/naoexiste", { password: PASSWORD })).status, 404);

    const anon = new Client(base);
    const lo = await anon.call("POST", "/api/auth/passkey/options", { email: "pk1@x.com" });
    assert.equal(lo.status, 200);
    assert.equal(lo.body.options.allowCredentials, undefined, "sem passkeys cadastradas não revela nada");
    const bad = await anon.call("POST", "/api/auth/passkey/verify", { token: lo.body.token, response: { id: "inexistente", rawId: "x", type: "public-key", response: {} } });
    assert.equal(bad.status, 401);
    assert.equal((await anon.call("POST", "/api/auth/passkey/verify", { token: "lixo", response: { id: "x" } })).status, 401);
    const key = (await a.call("POST", "/api/api-keys", { name: "k" })).body.token;
    assert.equal((await fetch(`${base}/api/profile/passkeys`, { headers: { Authorization: `Bearer ${key}` } })).status, 403);
  });

  it("login social só entra quem já tem conta, e respeita o 2FA", async () => {
    const mem = await memoryProvider();
    await register(base, "oauth1@x.com", "O1");
    const anon = () => new Client(base);
    assert.equal((await anon().call("POST", "/api/auth/oauth", { accessToken: "lixo" })).status, 401);
    const ok = anon();
    const r = await ok.call("POST", "/api/auth/oauth", { accessToken: mem.tokenFor("oauth1@x.com") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.email, "oauth1@x.com");
    assert.equal((await ok.call("GET", "/api/auth/me")).body.user.email, "oauth1@x.com");

    // Conta só no provedor (sem convite no Ethos): não cria conta sozinha.
    await mem.createUser("sem-convite@x.com", PASSWORD);
    assert.equal((await anon().call("POST", "/api/auth/oauth", { accessToken: mem.tokenFor("sem-convite@x.com") })).status, 403);

    // Com 2FA ativo, o login social também pede o código.
    const { totpAt } = await import("../src/totp.js");
    const a = await register(base, "oauth2@x.com", "O2");
    const setup = await a.call("POST", "/api/profile/mfa/setup", { password: PASSWORD });
    await a.call("POST", "/api/profile/mfa/enable", { code: totpAt(setup.body.secret) });
    const c = anon();
    const m = await c.call("POST", "/api/auth/oauth", { accessToken: mem.tokenFor("oauth2@x.com") });
    assert.equal(m.body.mfa_required, true);
    assert.equal(c.cookie, "");

    const cfg = (await anon().call("GET", "/api/auth/providers")).body;
    assert.deepEqual(cfg.providers, []);
  });
});

describe("anonimização da auditoria", () => {
  it("apaga nome, e-mail, IP e aparelho dos registros de contas encerradas há mais de N dias", async () => {
    const { db } = await import("../src/db.js");
    const { anonymizeOldAudit } = await import("../src/security.js");
    const a = await register(base, "anon1@x.com", "AN1");
    const b = await register(base, "anon2@x.com", "AN2");
    await a.call("PUT", "/api/profile", { name: "Fulano Auditado" });
    await b.call("PUT", "/api/profile", { name: "Beltrano Ativo" });
    await db.query("UPDATE users SET deleted_at = now() - interval '10 days' WHERE email = 'anon1@x.com'");
    assert.equal(await anonymizeOldAudit(30), 0, "ainda dentro do prazo de guarda");
    assert.ok((await anonymizeOldAudit(5)) > 0);
    const rows = await db.query<{ user_name: string; user_email: string | null; ip: string | null }>("SELECT user_name, user_email, ip FROM audit_logs WHERE user_id = (SELECT id FROM users WHERE email = 'anon1@x.com')");
    assert.ok(rows.length > 0 && rows.every((r) => r.user_name === "Usuário removido" && r.user_email === null && r.ip === null));
    const kept = await db.query<{ user_email: string | null }>("SELECT user_email FROM audit_logs WHERE user_id = (SELECT id FROM users WHERE email = 'anon2@x.com') AND user_email IS NOT NULL");
    assert.ok(kept.length > 0, "contas ativas não são tocadas");
    assert.equal(await anonymizeOldAudit(5), 0, "idempotente");
  });
});
