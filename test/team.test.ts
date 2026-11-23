import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client, PASSWORD, memoryProvider, register, startServer, tokenFrom } from "./helpers.js";

let base: string;
let close: () => Promise<void>;

before(async () => {
  ({ base, close } = await startServer());
});
after(async () => {
  await close();
});

/** Cria um convite como admin e devolve o token. */
async function invite(admin: Client, email: string, role = "colaborador", extra: Record<string, unknown> = {}) {
  const r = await admin.call("POST", "/api/invitations", { email, role, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: tokenFrom(r.body.link), link: r.body.link as string, id: r.body.invitation.id as number };
}

async function accept(token: string, name: string, password = PASSWORD) {
  const c = new Client(base);
  const r = await c.call("POST", `/api/invitations/by-token/${token}/accept`, { name, password });
  return { client: c, ...r };
}

describe("convites", () => {
  it("admin convida; o link usa APP_URL e o convidado aceita criando a conta", async () => {
    const admin = await register(base, "inv-admin@x.com", "Inv");
    const { token, link } = await invite(admin, "novo@x.com", "colaborador");
    assert.ok(link.startsWith("http://app.test/?invite="));

    const info = await new Client(base).call("GET", `/api/invitations/by-token/${token}`);
    assert.deepEqual(info.body, {
      email: "novo@x.com",
      role: "colaborador",
      organizationName: "Inv",
      existingAccount: false,
    });

    const r = await accept(token, "Novo Colaborador");
    assert.equal(r.status, 201);
    assert.equal(r.body.role, "colaborador");
    assert.equal((await r.client.call("GET", "/api/properties")).status, 200);
    assert.equal((await r.client.call("GET", "/api/members")).status, 403);

    // O novo usuário consegue entrar depois com a senha escolhida.
    const login = await new Client(base).call("POST", "/api/auth/login", { email: "novo@x.com", password: PASSWORD });
    assert.equal(login.status, 200);
  });

  it("só admin cria, lista e revoga convites", async () => {
    const admin = await register(base, "perm-admin@x.com", "Perm");
    const { token } = await invite(admin, "col@x.com");
    const col = (await accept(token, "Col")).client;
    assert.equal((await col.call("POST", "/api/invitations", { email: "x@x.com", role: "inquilino" })).status, 403);
    assert.equal((await col.call("GET", "/api/invitations")).status, 403);
    assert.equal((await new Client(base).call("GET", "/api/invitations")).status, 401);
  });

  it("o token é de uso único", async () => {
    const admin = await register(base, "once-admin@x.com", "Once");
    const { token } = await invite(admin, "once@x.com");
    assert.equal((await accept(token, "A")).status, 201);
    assert.equal((await accept(token, "B")).status, 404);
  });

  it("convite expirado ou inexistente não funciona", async () => {
    const admin = await register(base, "exp-admin@x.com", "Exp");
    const { token } = await invite(admin, "exp@x.com");
    const { db } = await import("../src/db.js");
    await db.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE email = 'exp@x.com'");
    assert.equal((await new Client(base).call("GET", `/api/invitations/by-token/${token}`)).status, 404);
    assert.equal((await accept(token, "X")).status, 404);
    assert.equal((await new Client(base).call("GET", "/api/invitations/by-token/nao-existe")).status, 404);
  });

  it("reenviar substitui o convite anterior; revogar invalida o link", async () => {
    const admin = await register(base, "re-admin@x.com", "Re");
    const first = await invite(admin, "re@x.com");
    const tenant = (await admin.call("POST", "/api/tenants", { name: "T", document: "1" })).body.item;
    const second = await invite(admin, "re@x.com", "inquilino", { tenantId: tenant.id });
    assert.notEqual(first.token, second.token);
    assert.equal((await new Client(base).call("GET", `/api/invitations/by-token/${first.token}`)).status, 404);
    assert.equal((await admin.call("GET", "/api/invitations")).body.invitations.length, 1);
    assert.equal((await admin.call("DELETE", `/api/invitations/${second.id}`)).status, 204);
    assert.equal((await new Client(base).call("GET", `/api/invitations/by-token/${second.token}`)).status, 404);
  });

  it("valida e-mail e papel, e recusa quem já é membro", async () => {
    const admin = await register(base, "val-admin@x.com", "Val");
    assert.equal((await admin.call("POST", "/api/invitations", { email: "ruim", role: "admin" })).status, 400);
    assert.equal((await admin.call("POST", "/api/invitations", { email: "a@x.com", role: "root" })).status, 400);
    assert.equal((await admin.call("POST", "/api/invitations", { email: "val-admin@x.com", role: "admin" })).status, 409);
  });

  it("senha curta no aceite é recusada e não consome o convite", async () => {
    const admin = await register(base, "short-admin@x.com", "Short");
    const { token } = await invite(admin, "short@x.com");
    assert.equal((await accept(token, "S", "123")).status, 400);
    assert.equal((await accept(token, "S")).status, 201);
  });

  it("conta existente aceita convite de outra organização com a senha dela e pode trocar de organização", async () => {
    const orgA = await register(base, "multi-a@x.com", "Multi A");
    const orgB = await register(base, "multi-b@x.com", "Multi B");
    const { token } = await invite(orgA, "multi-b@x.com", "colaborador");

    const info = await new Client(base).call("GET", `/api/invitations/by-token/${token}`);
    assert.equal(info.body.existingAccount, true);

    assert.equal((await accept(token, "Multi B", "senha-errada-999")).status, 401);
    const ok = await accept(token, "Multi B");
    assert.equal(ok.status, 201);
    assert.equal(ok.body.organization.name, "Multi A");

    const c = ok.client;
    const orgs = (await c.call("GET", "/api/auth/organizations")).body.organizations;
    assert.equal(orgs.length, 2);
    const own = orgs.find((o: { name: string }) => o.name === "Multi B");
    assert.equal((await c.call("POST", "/api/auth/switch", { organizationId: own.id })).status, 204);
    const me = (await c.call("GET", "/api/auth/me")).body;
    assert.equal(me.organization.name, "Multi B");
    assert.equal(me.role, "admin");
    // Não troca para organização da qual não participa.
    const outsider = await register(base, "multi-c@x.com", "Multi C");
    const foreign = (await outsider.call("GET", "/api/auth/me")).body.organization.id;
    assert.equal((await c.call("POST", "/api/auth/switch", { organizationId: foreign })).status, 403);
    assert.ok(orgB);
  });
});

describe("recuperação de senha", () => {
  it("fluxo completo: e-mail do provedor → nova senha → sessões antigas caem", async () => {
    const provider = await memoryProvider();
    const user = await register(base, "forgot@x.com", "Forgot");
    const anon = new Client(base);

    // E-mail desconhecido: mesma resposta, nada é enviado.
    const before = provider.sentRecoveries.length;
    assert.equal((await anon.call("POST", "/api/auth/forgot", { email: "ninguem@x.com" })).status, 204);
    assert.equal(provider.sentRecoveries.length, before);

    assert.equal((await anon.call("POST", "/api/auth/forgot", { email: "forgot@x.com" })).status, 204);
    const sent = provider.sentRecoveries.at(-1)!;
    assert.equal(sent.email, "forgot@x.com");
    assert.ok(sent.link.startsWith("http://app.test/#access_token="));
    const token = tokenFrom(sent.link);

    assert.equal((await anon.call("POST", "/api/auth/reset", { accessToken: token, password: "123" })).status, 400);
    assert.equal((await anon.call("POST", "/api/auth/reset", { accessToken: "lixo", password: "nova-senha-456" })).status, 400);
    assert.equal((await anon.call("POST", "/api/auth/reset", { accessToken: token, password: "nova-senha-456" })).status, 204);

    assert.equal((await user.call("GET", "/api/properties")).status, 401, "sessão antiga deve cair");
    assert.equal((await anon.call("POST", "/api/auth/login", { email: "forgot@x.com", password: PASSWORD })).status, 401);
    assert.equal((await anon.call("POST", "/api/auth/login", { email: "forgot@x.com", password: "nova-senha-456" })).status, 200);
    // O token não pode ser reutilizado.
    assert.equal((await anon.call("POST", "/api/auth/reset", { accessToken: token, password: "outra-senha-789" })).status, 400);
  });

  it("valida o formato do e-mail", async () => {
    assert.equal((await new Client(base).call("POST", "/api/auth/forgot", { email: "x" })).status, 400);
  });

  it("limita pedidos repetidos, sem revelar nada", async () => {
    const provider = await memoryProvider();
    await register(base, "spam@x.com", "Spam");
    const anon = new Client(base);
    const sentBefore = provider.sentRecoveries.length;
    for (let i = 0; i < 8; i++) {
      assert.equal((await anon.call("POST", "/api/auth/forgot", { email: "spam@x.com" })).status, 204);
    }
    assert.equal(provider.sentRecoveries.length - sentBefore, 5);
  });
});

describe("redefinição de senha pelo admin", () => {
  it("admin envia e-mail ou gera link para um membro", async () => {
    const provider = await memoryProvider();
    const admin = await register(base, "adm-reset@x.com", "AdmReset");
    const { token } = await invite(admin, "membro@x.com");
    await accept(token, "Membro");
    const member = (await admin.call("GET", "/api/members")).body.members.find(
      (m: { email: string }) => m.email === "membro@x.com",
    );

    const mail = await admin.call("POST", `/api/members/${member.id}/password-reset`, { mode: "email" });
    assert.equal(mail.status, 200);
    assert.equal(provider.sentRecoveries.at(-1)!.email, "membro@x.com");

    const link = await admin.call("POST", `/api/members/${member.id}/password-reset`, { mode: "link" });
    assert.equal(link.status, 200);
    const reset = await new Client(base).call("POST", "/api/auth/reset", {
      accessToken: tokenFrom(link.body.link),
      password: "senha-redefinida-1",
    });
    assert.equal(reset.status, 204);
    const login = await new Client(base).call("POST", "/api/auth/login", {
      email: "membro@x.com",
      password: "senha-redefinida-1",
    });
    assert.equal(login.status, 200);

    assert.equal((await admin.call("POST", `/api/members/${member.id}/password-reset`, { mode: "sms" })).status, 400);
  });

  it("colaborador não pode redefinir senhas", async () => {
    const admin = await register(base, "adm2@x.com", "Adm2");
    const col = (await accept((await invite(admin, "col2@x.com")).token, "Col2")).client;
    const members = (await admin.call("GET", "/api/members")).body.members;
    const adminId = members.find((m: { email: string }) => m.email === "adm2@x.com").id;
    assert.equal((await col.call("POST", `/api/members/${adminId}/password-reset`, { mode: "link" })).status, 403);
  });

  it("link só para quem pertence apenas a esta organização; e-mail continua permitido", async () => {
    const provider = await memoryProvider();
    const orgA = await register(base, "link-a@x.com", "Link A");
    await register(base, "link-b@x.com", "Link B");
    await accept((await invite(orgA, "link-b@x.com")).token, "B");
    const members = (await orgA.call("GET", "/api/members")).body.members;
    const b = members.find((m: { email: string }) => m.email === "link-b@x.com");

    const link = await orgA.call("POST", `/api/members/${b.id}/password-reset`, { mode: "link" });
    assert.equal(link.status, 409);
    assert.equal(link.body.link, undefined);

    const mail = await orgA.call("POST", `/api/members/${b.id}/password-reset`, { mode: "email" });
    assert.equal(mail.status, 200);
    assert.equal(provider.sentRecoveries.at(-1)!.email, "link-b@x.com");
  });

  it("admin de outra organização não alcança o usuário", async () => {
    const orgA = await register(base, "iso-a@x.com", "Iso A");
    const orgB = await register(base, "iso-b@x.com", "Iso B");
    const bId = (await orgB.call("GET", "/api/members")).body.members[0].id;
    assert.equal((await orgA.call("POST", `/api/members/${bId}/password-reset`, { mode: "link" })).status, 404);
    assert.equal((await orgA.call("PATCH", `/api/members/${bId}`, { role: "inquilino" })).status, 404);
    assert.equal((await orgA.call("DELETE", `/api/members/${bId}`)).status, 404);
    const inviteB = await invite(orgB, "alguem@x.com");
    assert.equal((await orgA.call("DELETE", `/api/invitations/${inviteB.id}`)).status, 404);
  });
});

describe("gestão de membros", () => {
  it("nunca deixa a organização sem administrador", async () => {
    const admin = await register(base, "last@x.com", "Last");
    const me = (await admin.call("GET", "/api/auth/me")).body.user.id;
    assert.equal((await admin.call("PATCH", `/api/members/${me}`, { role: "colaborador" })).status, 409);
    assert.equal((await admin.call("DELETE", `/api/members/${me}`)).status, 409);
    assert.equal((await admin.call("PATCH", `/api/members/${me}`, { role: "root" })).status, 400);
  });

  it("muda o papel e remove membros, encerrando a sessão deles", async () => {
    const admin = await register(base, "mgmt@x.com", "Mgmt");
    const col = (await accept((await invite(admin, "mgmt-col@x.com")).token, "Col")).client;
    const colId = (await col.call("GET", "/api/auth/me")).body.user.id;

    assert.equal((await admin.call("PATCH", `/api/members/${colId}`, { role: "admin" })).status, 200);
    assert.equal((await col.call("GET", "/api/members")).status, 200);
    assert.equal((await admin.call("DELETE", `/api/members/${colId}`)).status, 204);
    assert.equal((await col.call("GET", "/api/properties")).status, 401);
  });
});

describe("limite de tentativas de login", () => {
  it("bloqueia após muitas tentativas erradas", async () => {
    await register(base, "brute@x.com", "Brute");
    const c = new Client(base);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await c.call("POST", "/api/auth/login", { email: "brute@x.com", password: "errada" + i })).status);
    }
    assert.equal(statuses[0], 401);
    assert.equal(statuses.at(-1), 429);
  });
});
