import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, JPEG, PASSWORD, memoryProvider, register, startServer, tokenFrom } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  process.env.INTEGRATIONS_SECRET = "segredo-de-teste-com-mais-de-32-caracteres";
  ({ base, close } = await startServer());
});
after(async () => close());

const login = async (email: string, password = PASSWORD) => {
  const c = new Client(base);
  const r = await c.call("POST", "/api/auth/login", { email, password });
  return { c, ...r };
};

async function invite(admin: Client, email: string, role = "colaborador") {
  const r = await admin.call("POST", "/api/invitations", { email, role });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = new Client(base);
  const a = await c.call("POST", `/api/invitations/by-token/${tokenFrom(r.body.link)}/accept`, { name: "Convidado", password: PASSWORD });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  return c;
}

/** Liga o 2FA do cliente e devolve o segredo e os códigos de recuperação. */
async function enableMfa(c: Client) {
  const { totpAt } = await import("../src/totp.js");
  const setup = await c.call("POST", "/api/profile/mfa/setup", { password: PASSWORD });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const on = await c.call("POST", "/api/profile/mfa/enable", { code: totpAt(setup.body.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  return { secret: setup.body.secret as string, recovery: on.body.recovery_codes as string[] };
}

describe("verificação em duas etapas (TOTP)", () => {
  it("configura, exige o código no login, recusa código reutilizado e aceita recuperação uma única vez", async () => {
    const { totpAt, TOTP_STEP_S } = await import("../src/totp.js");
    const a = await register(base, "mfa1@x.com", "M1");
    assert.equal((await a.call("GET", "/api/profile/mfa")).body.enabled, false);
    assert.equal((await a.call("POST", "/api/profile/mfa/setup", {})).status, 400, "sem senha");
    assert.equal((await a.call("POST", "/api/profile/mfa/setup", { password: "errada-errada" })).status, 403);

    const setup = await a.call("POST", "/api/profile/mfa/setup", { password: PASSWORD });
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.uri, /^otpauth:\/\/totp\/Ethos:mfa1%40x\.com\?secret=/);
    assert.equal((await a.call("GET", "/api/profile/mfa")).body.enabled, false, "ainda configurando");
    assert.equal((await login("mfa1@x.com")).body.mfa_required, undefined, "configurar não exige código no login");
    assert.equal((await a.call("POST", "/api/profile/mfa/enable", { code: "000000" })).status, 400);
    const on = await a.call("POST", "/api/profile/mfa/enable", { code: totpAt(setup.body.secret) });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.recovery_codes.length, 10);
    assert.match(on.body.recovery_codes[0], /^[a-z0-9]{5}-[a-z0-9]{5}$/);
    const st = (await a.call("GET", "/api/profile/mfa")).body;
    assert.deepEqual([st.enabled, st.recovery_left], [true, 10]);
    assert.equal((await a.call("POST", "/api/profile/mfa/setup", { password: PASSWORD })).status, 409, "já ativo");

    // Login: a senha certa não basta, e nenhum cookie de sessão é criado.
    const r1 = await login("mfa1@x.com");
    assert.equal(r1.status, 200);
    assert.equal(r1.body.mfa_required, true);
    assert.equal(r1.c.cookie, "");
    assert.equal(r1.body.user, undefined);
    assert.equal((await r1.c.call("GET", "/api/auth/me")).body.user, null);

    // O código usado para ativar já gastou este passo de 30 s; para exercitar o login, recua o marcador.
    const { db: db0 } = await import("../src/db.js");
    await db0.query("UPDATE user_mfa SET last_step = last_step - 5 WHERE user_id = (SELECT id FROM users WHERE email = $1)", ["mfa1@x.com"]);
    const token = r1.body.mfa_token as string;
    assert.equal((await r1.c.call("POST", "/api/auth/mfa", { mfa_token: token, code: "123456" })).status, 401);
    assert.equal((await r1.c.call("POST", "/api/auth/mfa", { mfa_token: "token-inventado", code: "123456" })).status, 401);
    const good = totpAt(setup.body.secret);
    const done = await r1.c.call("POST", "/api/auth/mfa", { mfa_token: token, code: good });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.email, "mfa1@x.com");
    assert.equal((await r1.c.call("GET", "/api/auth/me")).body.user.email, "mfa1@x.com");
    assert.equal((await r1.c.call("POST", "/api/auth/mfa", { mfa_token: token, code: good })).status, 401, "o desafio é de uso único");

    // O mesmo código (mesmo passo de 30 s) não vale de novo; o do passo seguinte vale.
    const r2 = await login("mfa1@x.com");
    assert.equal((await r2.c.call("POST", "/api/auth/mfa", { mfa_token: r2.body.mfa_token, code: good })).status, 401, "código já usado");
    const next = totpAt(setup.body.secret, Date.now() + TOTP_STEP_S * 1000);
    assert.equal((await r2.c.call("POST", "/api/auth/mfa", { mfa_token: r2.body.mfa_token, code: next })).status, 200);

    // Código de recuperação: vale uma vez, com ou sem hífen/maiúsculas.
    const code = on.body.recovery_codes[0] as string;
    const r3 = await login("mfa1@x.com");
    assert.equal((await r3.c.call("POST", "/api/auth/mfa", { mfa_token: r3.body.mfa_token, code: code.toUpperCase().replace("-", "") })).status, 200);
    const r4 = await login("mfa1@x.com");
    assert.equal((await r4.c.call("POST", "/api/auth/mfa", { mfa_token: r4.body.mfa_token, code })).status, 401, "recuperação é de uso único");
    assert.equal((await a.call("GET", "/api/profile/mfa")).body.recovery_left, 9);
  });

  it("desafio morre depois de 5 erros e o segredo nunca vai ao banco em texto puro", async () => {
    const a = await register(base, "mfa2@x.com", "M2");
    const { secret } = await enableMfa(a);
    const r = await login("mfa2@x.com");
    for (let i = 0; i < 4; i++) assert.equal((await r.c.call("POST", "/api/auth/mfa", { mfa_token: r.body.mfa_token, code: "000000" })).status, 401);
    const last = await r.c.call("POST", "/api/auth/mfa", { mfa_token: r.body.mfa_token, code: "000000" });
    assert.match(last.body.error, /Entre novamente/);
    const { totpAt } = await import("../src/totp.js");
    assert.equal((await r.c.call("POST", "/api/auth/mfa", { mfa_token: r.body.mfa_token, code: totpAt(secret) })).status, 401, "nem o código certo salva um desafio queimado");

    const { db } = await import("../src/db.js");
    const [row] = await db.query<{ secret_enc: string }>("SELECT secret_enc FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE email = 'mfa2@x.com')");
    assert.ok(!row!.secret_enc.includes(secret) && row!.secret_enc.startsWith("v1."));
  });

  it("desativar e gerar novos códigos exigem senha e código; admin redefine o 2FA de um membro", async () => {
    const { totpAt, TOTP_STEP_S } = await import("../src/totp.js");
    const a = await register(base, "mfa3@x.com", "M3");
    const { secret, recovery } = await enableMfa(a);
    assert.equal((await a.call("POST", "/api/profile/mfa/disable", { password: PASSWORD, code: "000000" })).status, 403);
    assert.equal((await a.call("POST", "/api/profile/mfa/disable", { password: "errada-errada", code: totpAt(secret) })).status, 403);

    const fresh = await a.call("POST", "/api/profile/mfa/recovery-codes", { password: PASSWORD, code: totpAt(secret, Date.now() + TOTP_STEP_S * 1000) });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const r = await login("mfa3@x.com");
    assert.equal((await r.c.call("POST", "/api/auth/mfa", { mfa_token: r.body.mfa_token, code: recovery[1] })).status, 401, "os códigos antigos deixam de valer");

    // Um membro com 2FA perde o celular: o admin da organização (e só ele) desativa.
    const member = await invite(a, "mfa3-membro@x.com");
    const { id } = (await member.call("GET", "/api/auth/me")).body.user;
    const { secret: ms } = await enableMfa(member);
    assert.equal((await login("mfa3-membro@x.com")).body.mfa_required, true);
    assert.equal((await member.call("POST", `/api/members/${id}/mfa-reset`)).status, 403, "colaborador não redefine");
    assert.equal((await a.call("POST", `/api/members/${id}/mfa-reset`)).status, 204);
    assert.equal((await login("mfa3-membro@x.com")).body.mfa_required, undefined);
    assert.equal((await a.call("POST", "/api/members/999999/mfa-reset")).status, 404);
    assert.ok(ms);

    // Desativar o próprio 2FA com senha + um código de recuperação.
    const off = await a.call("POST", "/api/profile/mfa/disable", { password: PASSWORD, code: fresh.body.recovery_codes[0] });
    assert.equal(off.status, 204);
    assert.equal((await login("mfa3@x.com")).body.mfa_required, undefined);
    assert.equal((await a.call("GET", "/api/profile/mfa")).body.enabled, false);
  });

  it("chave de API não configura 2FA e a auditoria registra sem guardar códigos", async () => {
    const a = await register(base, "mfa4@x.com", "M4");
    const key = (await a.call("POST", "/api/api-keys", { name: "n8n" })).body.token;
    assert.equal((await fetch(`${base}/api/profile/mfa`, { headers: { Authorization: `Bearer ${key}` } })).status, 403);
    const { secret } = await enableMfa(a);
    const text = JSON.stringify((await a.call("GET", "/api/audit")).body);
    assert.match(text, /Ativou a verificação em duas etapas/);
    assert.ok(!text.includes(secret));
  });
});

describe("aparelhos (sessões)", () => {
  it("lista os aparelhos, marca o atual e encerra um específico", async () => {
    const a = await register(base, "sess1@x.com", "S1");
    const other = (await login("sess1@x.com")).c;
    const list = (await a.call("GET", "/api/profile/sessions")).body.items as { ref: string; current: boolean; device: string; ip: string | null }[];
    assert.equal(list.length, 2);
    assert.equal(list.filter((s) => s.current).length, 1);
    assert.ok(list.every((s) => /^[0-9a-f]{16}$/.test(s.ref) && s.device.length > 0));
    assert.ok(!JSON.stringify(list).includes(a.cookie.split("=")[1]!), "o id real da sessão nunca sai");

    const cur = list.find((s) => s.current)!;
    assert.equal((await a.call("DELETE", `/api/profile/sessions/${cur.ref}`)).status, 400, "a atual usa Sair");
    assert.equal((await a.call("DELETE", "/api/profile/sessions/0000000000000000")).status, 404);
    const target = list.find((s) => !s.current)!;
    assert.equal((await a.call("DELETE", `/api/profile/sessions/${target.ref}`)).status, 204);
    assert.equal((await other.call("GET", "/api/auth/me")).body.user, null);
    assert.equal((await a.call("GET", "/api/profile/sessions")).body.items.length, 1);

    // Sessão de OUTRA pessoa não pode ser encerrada pelo ref.
    const b = await register(base, "sess2@x.com", "S2");
    const bRef = (await b.call("GET", "/api/profile/sessions")).body.items[0].ref;
    assert.equal((await a.call("DELETE", `/api/profile/sessions/${bRef}`)).status, 404);
    assert.equal((await b.call("GET", "/api/auth/me")).body.user.email, "sess2@x.com");
  });

  it("guarda o navegador usado no login", async () => {
    await register(base, "sess3@x.com", "S3");
    const c = new Client(base);
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" },
      body: JSON.stringify({ email: "sess3@x.com", password: PASSWORD }),
    });
    c.cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const items = (await c.call("GET", "/api/profile/sessions")).body.items as { device: string }[];
    assert.ok(items.some((s) => s.device === "Chrome em Windows"));
  });
});

describe("foto de perfil", () => {
  it("envia, lê, valida o conteúdo e remove; é privada de cada usuário", async () => {
    const a = await register(base, "foto1@x.com", "F1");
    assert.equal((await a.call("GET", "/api/profile")).body.user.has_avatar, false);
    assert.equal((await a.call("GET", "/api/profile/avatar")).status, 404);

    const fake = await fetch(`${base}/api/profile/avatar`, { method: "PUT", headers: { "Content-Type": "image/jpeg", Cookie: a.cookie }, body: "isso não é imagem" });
    assert.equal(fake.status, 400, "magic bytes");
    const put = await fetch(`${base}/api/profile/avatar`, { method: "PUT", headers: { "Content-Type": "image/jpeg", Cookie: a.cookie }, body: new Uint8Array(JPEG) });
    assert.equal(put.status, 200);
    const prof = (await a.call("GET", "/api/profile")).body.user;
    assert.equal(prof.has_avatar, true);
    assert.ok(prof.avatar_version > 0);

    const got = await fetch(`${base}/api/profile/avatar`, { headers: { Cookie: a.cookie } });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/jpeg");
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);

    const big = Buffer.concat([JPEG, Buffer.alloc(1.2 * 1024 * 1024)]);
    const tooBig = await fetch(`${base}/api/profile/avatar`, { method: "PUT", headers: { "Content-Type": "image/jpeg", Cookie: a.cookie }, body: new Uint8Array(big) });
    assert.equal(tooBig.status, 413);

    const b = await register(base, "foto2@x.com", "F2");
    assert.equal((await b.call("GET", "/api/profile/avatar")).status, 404, "a foto de outro usuário não aparece");
    assert.equal((await new Client(base).call("GET", "/api/profile/avatar")).status, 401);
    assert.equal((await a.call("DELETE", "/api/profile/avatar")).status, 204);
    assert.equal((await a.call("GET", "/api/profile")).body.user.has_avatar, false);
  });
});

describe("LGPD: exportar e encerrar a conta", () => {
  it("exporta os dados da própria pessoa sem segredos", async () => {
    const a = await register(base, "lgpd1@x.com", "L1");
    await a.call("PUT", "/api/profile", { phone: "11912345678" });
    const { secret, recovery } = await enableMfa(a);
    const res = await fetch(`${base}/api/profile/export`, { headers: { Cookie: a.cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
    const text = await res.text();
    const data = JSON.parse(text);
    assert.equal(data.profile.email, "lgpd1@x.com");
    assert.equal(data.profile.phone, "(11) 91234-5678");
    assert.equal(data.organizations[0].role, "admin");
    assert.equal(data.two_factor.enabled, true);
    assert.ok(data.activity.length > 0);
    for (const secretText of [secret, recovery[0]!, PASSWORD, "secret_enc", "code_hash", "token_hash"]) assert.ok(!text.includes(secretText), `não pode vazar ${secretText}`);
    assert.equal((await new Client(base).call("GET", "/api/profile/export")).status, 401);
  });

  it("encerrar a conta: confirma, exige senha (e 2FA), apaga dados pessoais e derruba o login", async () => {
    const { totpAt, TOTP_STEP_S } = await import("../src/totp.js");
    const owner = await register(base, "lgpd2@x.com", "L2");
    // Único administrador: não pode sair sem passar a função.
    assert.equal((await owner.call("POST", "/api/profile/delete", { confirm: "EXCLUIR", password: PASSWORD })).status, 409);

    const colab = await invite(owner, "lgpd2-colab@x.com", "colaborador");
    const adm2 = await invite(owner, "lgpd2-adm@x.com", "admin");
    assert.equal((await colab.call("GET", "/api/auth/me")).status, 200);
    await colab.call("PUT", "/api/profile", { phone: "11999998888", document: "52998224725", birth_date: "1990-01-01" });
    const { secret } = await enableMfa(colab);

    assert.equal((await colab.call("POST", "/api/profile/delete", { password: PASSWORD })).status, 400, "sem digitar EXCLUIR");
    assert.equal((await colab.call("POST", "/api/profile/delete", { confirm: "EXCLUIR", password: "errada-errada" })).status, 403);
    assert.equal((await colab.call("POST", "/api/profile/delete", { confirm: "EXCLUIR", password: PASSWORD })).status, 403, "2FA ativo exige o código");
    const ok = await colab.call("POST", "/api/profile/delete", { confirm: "EXCLUIR", password: PASSWORD, code: totpAt(secret, Date.now() + TOTP_STEP_S * 1000) });
    assert.equal(ok.status, 204, JSON.stringify(ok.body));

    assert.equal((await colab.call("GET", "/api/auth/me")).body.user, null, "sessão encerrada");
    assert.equal((await login("lgpd2-colab@x.com")).status, 401, "não entra mais");
    const { db } = await import("../src/db.js");
    const [u] = await db.query<{ name: string; email: string; phone: string | null; document: string | null; deleted_at: string | null }>(
      "SELECT name, email, phone, document, deleted_at FROM users WHERE email LIKE 'removido-%' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(u!.name, "Conta encerrada");
    assert.equal(u!.phone, null);
    assert.equal(u!.document, null);
    assert.ok(u!.deleted_at);
    const members = (await owner.call("GET", "/api/members")).body.items ?? (await owner.call("GET", "/api/members")).body;
    assert.ok(!JSON.stringify(members).includes("lgpd2-colab@x.com"));
    // O e-mail liberado pode ser usado de novo e a auditoria preserva o histórico.
    assert.equal((await new Client(base).call("POST", "/api/auth/register", { name: "Volta", email: "lgpd2-colab@x.com", password: PASSWORD })).status, 201);
    // Com outro administrador, o primeiro também pode sair.
    assert.equal((await adm2.call("GET", "/api/auth/me")).status, 200);
    assert.equal((await owner.call("POST", "/api/profile/delete", { confirm: "EXCLUIR", password: PASSWORD })).status, 204);
  });
});

describe("CSRF", () => {
  it("escrita vinda de outro site é bloqueada; a do próprio site e a sem Origin (API) passam", async () => {
    const a = await register(base, "csrf1@x.com", "C1");
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/profile/sessions/logout-others`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: a.cookie, ...headers } });
    assert.equal((await post({ Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ Origin: "null" })).status, 403);
    assert.equal((await post({ "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post({ "Sec-Fetch-Site": "same-site" })).status, 403);
    assert.equal((await post({ Origin: base })).status, 200);
    assert.equal((await post({ Origin: "http://app.test" })).status, 200, "APP_URL também é origem confiável");
    assert.equal((await post({ "Sec-Fetch-Site": "same-origin" })).status, 200);
    assert.equal((await post({})).status, 200);
    // O login também não aceita formulário vindo de outro site (login CSRF).
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ email: "csrf1@x.com", password: PASSWORD }) });
    assert.equal(login.status, 403);
    // Leitura nunca é bloqueada.
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Origin: "https://evil.example", Cookie: a.cookie } })).status, 200);
  });
});

describe("limite de tentativas compartilhado", () => {
  it("duas instâncias com o mesmo escopo dividem a contagem (guardada no banco, com a chave em hash)", async () => {
    const { SharedRateLimiter } = await import("../src/ratelimit.js");
    const one = new SharedRateLimiter("teste-escopo", 3, 60_000);
    const two = new SharedRateLimiter("teste-escopo", 3, 60_000);
    const other = new SharedRateLimiter("outro-escopo", 3, 60_000);
    const key = "alguem@x.com|1.2.3.4";
    assert.deepEqual([await one.allow(key), await two.allow(key), await one.allow(key)], [true, true, true]);
    assert.equal(await two.allow(key), false, "a 4ª tentativa, por outra instância, já cai");
    assert.equal(await other.allow(key), true, "escopo diferente conta à parte");
    await two.reset(key);
    assert.equal(await one.allow(key), true);

    const { db } = await import("../src/db.js");
    const keys = await db.query<{ key: string }>("SELECT key FROM rate_limits");
    assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key)), "só hash: sem e-mail nem IP legíveis");

    const short = new SharedRateLimiter("janela", 1, 150);
    assert.equal(await short.allow("k"), true);
    assert.equal(await short.allow("k"), false);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await short.allow("k"), true, "a janela venceu");
  });
});

describe("verificação de e-mail no cadastro (REQUIRE_EMAIL_VERIFICATION=1)", () => {
  it("não abre sessão até o clique no link; reenvio sempre responde 204", async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = "1";
    try {
      const mem = await memoryProvider();
      const c = new Client(base);
      const r = await c.call("POST", "/api/auth/register", { name: "Novo", email: "verif1@x.com", password: PASSWORD, organizationName: "V1" });
      assert.equal(r.status, 201);
      assert.equal(r.body.verification_required, true);
      assert.equal(c.cookie, "", "sem sessão");
      assert.equal(mem.sentVerifications.filter((m) => m.email === "verif1@x.com").length, 1);

      const blocked = await login("verif1@x.com");
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, "email_unconfirmed");

      assert.equal((await new Client(base).call("POST", "/api/auth/resend-verification", { email: "verif1@x.com" })).status, 204);
      assert.equal((await new Client(base).call("POST", "/api/auth/resend-verification", { email: "ninguem@x.com" })).status, 204);
      assert.equal(mem.sentVerifications.filter((m) => m.email === "verif1@x.com").length, 2);
      assert.equal(mem.sentVerifications.filter((m) => m.email === "ninguem@x.com").length, 0);

      mem.clickLink(mem.sentVerifications.at(-1)!.link);
      assert.equal((await login("verif1@x.com")).status, 200);
    } finally {
      delete process.env.REQUIRE_EMAIL_VERIFICATION;
    }
    // Sem a variável, o cadastro continua abrindo a sessão na hora.
    assert.equal((await new Client(base).call("POST", "/api/auth/register", { name: "Sem", email: "verif2@x.com", password: PASSWORD })).status, 201);
  });
});
