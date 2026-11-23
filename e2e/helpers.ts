import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "demo-1234-senha";
export const ADMIN = "admin@demo.test";
export const TENANT = "demo.inquilino@example.com";
export const OWNER = "demo.proprietario@example.com";

/** Campo de senha do formulário (o botão "olho" fica dentro do label, então getByLabel("Senha") acharia dois elementos). */
export const passwordField = (page: Page) => page.locator('input[autocomplete$="-password"]');

/** Entra pela API (rápido): o cookie de sessão fica no contexto do navegador. */
export async function loginApi(page: Page, email = ADMIN, password = DEMO_PASSWORD) {
  const res = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(res.ok(), `login de ${email}: HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
}

/** Entra pela tela de login (para testar o formulário). */
export async function loginUi(page: Page, email = ADMIN, password = DEMO_PASSWORD) {
  await page.goto("/#/entrar");
  await page.getByLabel("E-mail").fill(email);
  await passwordField(page).fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

/** Abre o painel já logado e espera o menu aparecer. */
export async function openPanel(page: Page, email = ADMIN) {
  await loginApi(page, email);
  await page.goto("/");
  await expect(page.locator(".topbar")).toBeVisible(); // o menu pode estar recolhido/oculto (celular)
}

export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

/** CPF fictício, só dígitos, único por chamada (o servidor não valida dígito verificador no cadastro manual). */
export const fakeDoc = () => String(Math.floor(10_000_000_000 + Math.random() * 89_999_999_999));

/** Cria um colaborador (convite aceito pela API) e devolve o e-mail. */
export async function createColaborador(request: APIRequestContext, adminPage: Page): Promise<string> {
  const email = `col-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}@demo.test`;
  const inv = await adminPage.request.post("/api/invitations", { data: { email, role: "colaborador" } });
  const { link } = await inv.json();
  const token = new URL(link).searchParams.get("invite")!;
  const res = await request.post(`/api/invitations/by-token/${token}/accept`, { data: { name: "Colaborador E2E", password: DEMO_PASSWORD } });
  expect(res.ok()).toBeTruthy();
  return email;
}
