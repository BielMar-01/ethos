import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, register, startServer, tokenFrom } from "./helpers.js";

let base: string;
let close: () => Promise<void>;
before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

async function addMember(admin: Client, email: string, role = "colaborador") {
  const inv = await admin.call("POST", "/api/invitations", { email, role });
  const c = new Client(base);
  const r = await c.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { name: email, password: PASSWORD });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { client: c, id: r.body.user.id as number };
}
const login = (email: string, password: string) => new Client(base).call("POST", "/api/auth/login", { email, password });

describe("admin define a senha de um usuário pela tela", () => {
  it("define a senha digitada: a antiga para de valer, a nova entra e as sessões caem", async () => {
    const admin = await register(base, "pw-admin@x.com", "Pw");
    const m = await addMember(admin, "pw-col@x.com");
    assert.equal((await m.client.call("GET", "/api/auth/me")).body.user.email, "pw-col@x.com");
    const r = await admin.call("POST", `/api/members/${m.id}/password-reset`, { mode: "password", password: "Nova-senha-123" });
    assert.equal(r.status, 200);
    assert.equal(r.body.password, undefined, "senha digitada não volta na resposta");
    assert.equal((await login("pw-col@x.com", PASSWORD)).status, 401);
    assert.equal((await login("pw-col@x.com", "Nova-senha-123")).status, 200);
    assert.equal((await m.client.call("GET", "/api/auth/me")).body.user, null, "sessão antiga encerrada");
  });

  it("sem senha informada gera uma temporária e mostra uma única vez", async () => {
    const admin = await register(base, "pw-admin2@x.com", "Pw2");
    const m = await addMember(admin, "pw-col2@x.com", "colaborador");
    const r = await admin.call("POST", `/api/members/${m.id}/password-reset`, { mode: "password" });
    assert.equal(r.status, 200);
    assert.match(r.body.password, /^[A-Za-z0-9]{14}$/);
    assert.equal((await login("pw-col2@x.com", r.body.password)).status, 200);
  });

  it("o próprio admin troca a senha sem perder a sessão atual", async () => {
    const admin = await register(base, "pw-self@x.com", "PwSelf");
    const me = (await admin.call("GET", "/api/auth/me")).body.user.id;
    assert.equal((await admin.call("POST", `/api/members/${me}/password-reset`, { mode: "password", password: "Outra-senha-1" })).status, 200);
    assert.equal((await admin.call("GET", "/api/auth/me")).body.user.id, me);
    assert.equal((await login("pw-self@x.com", "Outra-senha-1")).status, 200);
  });

  it("valida tamanho, exige admin, respeita outras organizações e fica no registro sem a senha", async () => {
    const admin = await register(base, "pw-admin3@x.com", "Pw3");
    const other = await register(base, "pw-other@x.com", "PwOther");
    const m = await addMember(admin, "pw-col3@x.com");
    assert.equal((await admin.call("POST", `/api/members/${m.id}/password-reset`, { mode: "password", password: "curta" })).status, 400);
    assert.equal((await m.client.call("POST", `/api/members/${m.id}/password-reset`, { mode: "password" })).status, 403, "colaborador não pode");
    const outsider = (await other.call("GET", "/api/auth/me")).body.user.id;
    assert.equal((await admin.call("POST", `/api/members/${outsider}/password-reset`, { mode: "password" })).status, 404, "de outra organização");

    // Usuário que está em duas organizações: só redefinição por e-mail.
    const inv = await other.call("POST", "/api/invitations", { email: "pw-col3@x.com", role: "colaborador" });
    await m.client.call("POST", `/api/invitations/by-token/${tokenFrom(inv.body.link)}/accept`, { password: PASSWORD });
    assert.equal((await admin.call("POST", `/api/members/${m.id}/password-reset`, { mode: "password" })).status, 409);

    await admin.call("POST", `/api/members/${(await addMember(admin, "pw-col4@x.com")).id}/password-reset`, { mode: "password", password: "Segredo-audit-9" });
    await new Promise((ok) => setTimeout(ok, 200));
    const logs = (await admin.call("GET", "/api/audit")).body.items;
    assert.ok(logs.some((l: { summary: string }) => /Redefiniu a senha/.test(l.summary)));
    assert.ok(!JSON.stringify(logs).includes("Segredo-audit-9"));
  });
});
