import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, memoryProvider, register, startServer } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => close());

const login = async (email: string, password = PASSWORD) => {
  const c = new Client(base);
  const r = await c.call("POST", "/api/auth/login", { email, password });
  return { c, status: r.status };
};

describe("meu perfil", () => {
  it("lê e atualiza nome, telefone, CPF e nascimento (com máscara) e aceita limpar", async () => {
    const a = await register(base, "perfil1@x.com", "P1");
    const me = await a.call("GET", "/api/profile");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "perfil1@x.com");
    assert.equal(me.body.role, "admin");
    assert.equal(me.body.user.phone, null);

    const r = await a.call("PUT", "/api/profile", { name: "  Maria   da Silva ", phone: "+55 11 91234-5678", document: "52998224725", birth_date: "1990-05-17" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.name, "Maria da Silva");
    assert.equal(r.body.user.phone, "(11) 91234-5678");
    assert.equal(r.body.user.document, "529.982.247-25");
    assert.equal(String(r.body.user.birth_date).slice(0, 10), "1990-05-17");
    assert.equal((await a.call("GET", "/api/auth/me")).body.user.name, "Maria da Silva", "a sessão enxerga o novo nome");

    // Campos omitidos ficam como estão; string vazia limpa.
    const keep = await a.call("PUT", "/api/profile", { name: "Maria S." });
    assert.equal(keep.body.user.phone, "(11) 91234-5678");
    const clear = await a.call("PUT", "/api/profile", { phone: "", document: "", birth_date: "" });
    assert.equal(clear.body.user.phone, null);
    assert.equal(clear.body.user.document, null);
    assert.equal(clear.body.user.birth_date, null);
  });

  it("recusa dados inválidos", async () => {
    const a = await register(base, "perfil2@x.com", "P2");
    const bad = (b: Record<string, unknown>) => a.call("PUT", "/api/profile", b);
    assert.equal((await bad({ name: "A" })).status, 400);
    assert.equal((await bad({ name: "x".repeat(101) })).status, 400);
    assert.equal((await bad({ phone: "123" })).status, 400);
    assert.equal((await bad({ document: "123" })).status, 400);
    assert.equal((await bad({ birth_date: "2999-01-01" })).status, 400);
    assert.equal((await bad({ birth_date: "1990-02-30" })).status, 400);
    assert.equal((await new Client(base).call("GET", "/api/profile")).status, 401);
  });

  it("troca de e-mail só vale depois do link enviado ao endereço NOVO", async () => {
    const a = await register(base, "perfil3@x.com", "P3");
    await register(base, "ocupado3@x.com", "P3b");
    const mem = await memoryProvider();
    assert.equal((await a.call("POST", "/api/profile/email", { email: "novo3@x.com" })).status, 400, "sem senha");
    assert.equal((await a.call("POST", "/api/profile/email", { email: "novo3@x.com", password: "errada-errada" })).status, 403);
    assert.equal((await a.call("POST", "/api/profile/email", { email: "ocupado3@x.com", password: PASSWORD })).status, 409);
    assert.equal((await a.call("POST", "/api/profile/email", { email: "isso-nao-e-email", password: PASSWORD })).status, 400);

    const ok = await a.call("POST", "/api/profile/email", { email: "  NOVO3@x.com ", password: PASSWORD });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.equal(ok.body.user.email, "perfil3@x.com", "ainda vale o e-mail antigo");
    assert.equal(ok.body.user.pending_email, "novo3@x.com");
    assert.equal((await login("perfil3@x.com")).status, 200, "o login antigo continua funcionando até confirmar");
    assert.equal((await login("novo3@x.com")).status, 401);

    // O link vai ao endereço novo; o clique é do provedor, e o app só espelha o que ele confirmou.
    const sent = mem.sentEmailChanges.filter((m) => m.email === "novo3@x.com");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.link, /^http:\/\/app\.test\//);
    const token = mem.clickLink(sent[0]!.link);
    const sync = await new Client(base).call("POST", "/api/auth/email-confirmed", { accessToken: token });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.email, "novo3@x.com");
    assert.equal((await a.call("GET", "/api/auth/me")).body.user.email, "novo3@x.com");
    assert.equal((await a.call("GET", "/api/profile")).body.user.pending_email, null);
    assert.equal((await login("novo3@x.com")).status, 200);
    assert.equal((await login("perfil3@x.com")).status, 401);
    assert.equal((await new Client(base).call("POST", "/api/auth/email-confirmed", { accessToken: "lixo" })).status, 400);
  });

  it("se o app não espelhou o clique, o próximo login com o e-mail novo alinha tudo", async () => {
    const a = await register(base, "perfil3b@x.com", "P3c");
    const mem = await memoryProvider();
    await a.call("POST", "/api/profile/email", { email: "novo3b@x.com", password: PASSWORD });
    mem.clickLink(mem.sentEmailChanges.find((m) => m.email === "novo3b@x.com")!.link); // clicou, mas o navegador não voltou ao app
    const r = await login("novo3b@x.com");
    assert.equal(r.status, 200);
    assert.equal((await r.c.call("GET", "/api/profile")).body.user.email, "novo3b@x.com");
    assert.equal((await r.c.call("GET", "/api/profile")).body.user.pending_email, null);
  });

  it("troca de senha: confere a atual, derruba as OUTRAS sessões e mantém a atual", async () => {
    const a = await register(base, "perfil4@x.com", "P4");
    const other = (await login("perfil4@x.com")).c;
    assert.equal((await other.call("GET", "/api/auth/me")).body.user.email, "perfil4@x.com");

    const call = (b: Record<string, unknown>) => a.call("POST", "/api/profile/password", b);
    assert.equal((await call({ current_password: "errada-errada", new_password: "nova-senha-123" })).status, 403);
    assert.equal((await call({ current_password: PASSWORD, new_password: "curta" })).status, 400);
    assert.equal((await call({ current_password: PASSWORD, new_password: PASSWORD })).status, 400, "igual à atual");
    assert.equal((await call({ current_password: PASSWORD, new_password: "nova-senha-123" })).status, 204);

    assert.equal((await a.call("GET", "/api/auth/me")).body.user.email, "perfil4@x.com", "a sessão atual continua");
    assert.equal((await other.call("GET", "/api/auth/me")).body.user, null, "a outra sessão caiu");
    assert.equal((await login("perfil4@x.com", PASSWORD)).status, 401);
    assert.equal((await login("perfil4@x.com", "nova-senha-123")).status, 200);
  });

  it("limita tentativas de senha atual", async () => {
    const a = await register(base, "perfil5@x.com", "P5");
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await a.call("POST", "/api/profile/password", { current_password: "errada-errada", new_password: "nova-senha-123" })).status;
    assert.equal(last, 429);
  });

  it("encerrar outras sessões", async () => {
    const a = await register(base, "perfil6@x.com", "P6");
    const b = (await login("perfil6@x.com")).c;
    const r = await a.call("POST", "/api/profile/sessions/logout-others");
    assert.equal(r.status, 200);
    assert.equal(r.body.ended, 1);
    assert.equal((await b.call("GET", "/api/auth/me")).body.user, null);
    assert.equal((await a.call("GET", "/api/auth/me")).body.user.email, "perfil6@x.com");
  });

  it("chave de API não tem perfil; a auditoria registra a ação sem guardar senhas", async () => {
    const a = await register(base, "perfil7@x.com", "P7");
    const key = (await a.call("POST", "/api/api-keys", { name: "n8n" })).body.token;
    const viaKey = await fetch(`${base}/api/profile`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(viaKey.status, 403);

    await a.call("PUT", "/api/profile", { name: "Admin Renomeado" });
    await a.call("POST", "/api/profile/password", { current_password: PASSWORD, new_password: "segredo-novo-987" });
    const log = await a.call("GET", "/api/audit");
    const text = JSON.stringify(log.body);
    assert.match(text, /Atualizou o próprio perfil/);
    assert.match(text, /Alterou a própria senha/);
    assert.ok(!text.includes("segredo-novo-987"), "a senha nunca vai para a auditoria");
    assert.ok(!text.includes(PASSWORD));
  });
});
