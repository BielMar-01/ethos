import { createHmac } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { DEMO_PASSWORD, createColaborador, loginUi, openPanel } from "./helpers";

/** TOTP (RFC 6238) mínimo para o teste "ser" o aplicativo autenticador. */
function totp(secretB32: string, step = 0): string {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretB32.toUpperCase().replace(/[^A-Z2-7]/g, "")) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + step));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** Colaborador novo, já logado pela tela, na página "Meu perfil". */
async function freshProfile(page: Page, request: import("@playwright/test").APIRequestContext, admin: Page) {
  const email = await createColaborador(request, admin);
  await loginUi(page, email);
  await expect(page.locator(".topbar")).toBeVisible();
  await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: /Meu perfil/ }).click();
  await expect(page.getByRole("heading", { name: "Meu perfil" })).toBeVisible();
  return email;
}

/** Sai pela API e recarrega o app para ele esquecer a sessão em memória. */
async function signOut(page: Page) {
  await page.request.post("/api/auth/logout");
  await page.goto("/");
  await page.reload();
}

test.describe("verificação em duas etapas", () => {
  test("ativa pelo perfil, o login passa a pedir o código, recuperação vale uma vez e dá para desativar", async ({ page, browser, request }) => {
    const admin = await browser.newPage();
    await openPanel(admin);
    const email = await freshProfile(page, request, admin);

    await page.getByRole("button", { name: "Ativar verificação em duas etapas" }).click();
    let dlg = page.getByRole("dialog");
    await dlg.getByLabel("Senha atual").fill(DEMO_PASSWORD);
    await dlg.getByRole("button", { name: "Continuar" }).click();
    await expect(dlg.getByRole("img", { name: /QR code/ })).toBeVisible();
    const secret = ((await dlg.locator(".access-code").textContent()) ?? "").replace(/\s/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    await dlg.getByLabel("Código de 6 dígitos").fill("000000");
    await dlg.getByRole("button", { name: "Ativar", exact: true }).click();
    await expect(dlg.getByRole("alert")).toContainText("Código incorreto");
    await dlg.getByLabel("Código de 6 dígitos").fill(totp(secret));
    await dlg.getByRole("button", { name: "Ativar", exact: true }).click();
    await expect(dlg.getByText("Ativada")).toBeVisible();
    const codes = await dlg.getByRole("list", { name: "Códigos de recuperação" }).locator("code").allTextContents();
    expect(codes).toHaveLength(10);
    await dlg.getByRole("button", { name: "Guardei os códigos" }).click();
    await expect(page.getByText("10 código(s) de recuperação restante(s)")).toBeVisible();

    // Sai e entra de novo: a senha certa não basta.
    await signOut(page);
    await loginUi(page, email);
    await expect(page.getByRole("heading", { name: "Verificação em duas etapas" })).toBeVisible();
    await page.getByLabel("Código de verificação").fill("000000");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByRole("alert")).toContainText("Código incorreto");
    await page.getByLabel("Código de verificação").fill(codes[0]!);
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator(".topbar")).toBeVisible();

    // O mesmo código de recuperação não vale duas vezes.
    await signOut(page);
    await loginUi(page, email);
    await page.getByLabel("Código de verificação").fill(codes[0]!);
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByRole("alert")).toContainText("Código incorreto");
    await page.getByLabel("Código de verificação").fill(codes[1]!);
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator(".topbar")).toBeVisible();

    // Desativar.
    await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: /Meu perfil/ }).click();
    await page.getByRole("button", { name: "Desativar", exact: true }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByLabel("Senha atual").fill(DEMO_PASSWORD);
    await dlg.getByLabel("Código de verificação").fill(codes[2]!);
    await dlg.getByRole("button", { name: "Desativar", exact: true }).click();
    await expect(page.getByText("Verificação em duas etapas desativada.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ativar verificação em duas etapas" })).toBeVisible();
    await admin.close();
  });

  test("admin redefine o 2FA de um membro pela equipe", async ({ page, request }) => {
    await openPanel(page);
    const email = await createColaborador(request, page);
    await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: "Equipe", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: email });
    await row.getByRole("button", { name: "Redefinir 2FA" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Desativar 2FA" }).click();
    await expect(page.getByText(/Verificação em duas etapas de .* desativada/)).toBeVisible();
  });
});

test.describe("perfil: foto, e-mail com confirmação, aparelhos e privacidade", () => {
  test("foto aparece no menu; troca de e-mail fica pendente; aparelhos listam e encerram; exporta os dados", async ({ page, browser, request }) => {
    const admin = await browser.newPage();
    await openPanel(admin);
    const email = await freshProfile(page, request, admin);

    // Foto de perfil (recortada e reduzida no navegador antes de enviar).
    await page.getByLabel("Escolher foto de perfil").setInputFiles({ name: "eu.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(page.getByText("Foto de perfil atualizada.")).toBeVisible();
    await expect(page.locator(".user-card .avatar img")).toBeVisible();
    await page.getByRole("button", { name: "Remover", exact: true }).click();
    await expect(page.locator(".user-card .avatar img")).toHaveCount(0);

    // E-mail: o login continua o antigo até clicar no link enviado ao novo.
    await page.getByLabel("Novo e-mail").fill("novo-" + email);
    await page.getByLabel("Senha atual para trocar o e-mail").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Enviar link de confirmação" }).click();
    await expect(page.getByText("Enviamos um link de confirmação para")).toBeVisible();
    await expect(page.getByText("Aguardando confirmação:")).toContainText("novo-" + email);
    await expect(page.getByText("Hoje:")).toContainText(email);

    // Aparelhos: um segundo login aparece na lista e pode ser encerrado.
    await expect(page.getByText("este aparelho")).toBeVisible();
    const other = await request.post("/api/auth/login", { data: { email, password: DEMO_PASSWORD } });
    expect(other.ok()).toBeTruthy();
    await page.reload();
    await page.getByRole("complementary", { name: "Menu principal" }).getByRole("button", { name: /Meu perfil/ }).click();
    const items = page.locator(".device-list li");
    await expect(items).toHaveCount(3); // esta, a do convite aceito e a do segundo login
    await page.getByRole("button", { name: /Encerrar sessão de/ }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Encerrar", exact: true }).click();
    await expect(page.getByText("Sessão encerrada.")).toBeVisible();
    await expect(items).toHaveCount(2);

    // LGPD: baixar os próprios dados.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar meus dados (.json)" }).click()]);
    expect(download.suggestedFilename()).toBe("meus-dados-ethos.json");
    await admin.close();
  });

  test("encerrar a conta apaga o acesso", async ({ page, browser, request }) => {
    const admin = await browser.newPage();
    await openPanel(admin);
    const email = await freshProfile(page, request, admin);
    await page.getByRole("button", { name: "Encerrar minha conta" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Senha atual").fill(DEMO_PASSWORD);
    await expect(dlg.getByRole("button", { name: "Encerrar conta" })).toBeDisabled();
    await dlg.getByLabel("Digite EXCLUIR para confirmar").fill("EXCLUIR");
    await dlg.getByRole("button", { name: "Encerrar conta" }).click();
    await expect(page.locator(".topbar")).toHaveCount(0);
    const again = await request.post("/api/auth/login", { data: { email, password: DEMO_PASSWORD } });
    expect(again.status()).toBe(401);
    await admin.close();
  });
});

test.describe("links de e-mail", () => {
  test("link de troca de e-mail inválido mostra o erro; link de cadastro confirma", async ({ page }) => {
    await page.goto("/#access_token=lixo&type=email_change");
    await expect(page.getByRole("heading", { name: "Não foi possível confirmar" })).toBeVisible();
    await page.goto("/#access_token=qualquer&type=signup");
    await page.reload();
    await expect(page.getByRole("heading", { name: "E-mail confirmado" })).toBeVisible();
    await page.getByRole("button", { name: "Ir para o login" }).click();
    await expect(page).toHaveURL(/#\/entrar/);
    await expect(page.getByRole("heading", { name: "Entrar", exact: true })).toBeVisible();
  });
});
