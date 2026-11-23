import { test, expect } from "@playwright/test";
import { passwordField } from "./helpers";

test.describe("home pública (computador)", () => {
  test("o conteúdo fica centralizado e não vaza para os lados", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const vw = page.viewportSize()!.width;
    // O bloco de texto do hero e o painel de exemplo ficam dentro de uma coluna central, com folga dos dois lados.
    const hero = await page.locator(".hero-text").boundingBox();
    const mock = await page.locator(".mock").boundingBox();
    const left = hero!.x;
    const right = vw - (mock!.x + mock!.width);
    expect(left).toBeGreaterThan(60);
    expect(Math.abs(left - right)).toBeLessThan(40); // margens esquerda e direita praticamente iguais
    // Sem rolagem horizontal.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("botões de ação levam ao login e ao cadastro", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Já tenho conta" }).click();
    await expect(page).toHaveURL(/#\/entrar/);
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
    await page.goto("/");
    await page.getByRole("banner").getByRole("button", { name: "Começar agora" }).click();
    await expect(page).toHaveURL(/#\/cadastro/);
    await expect(page.getByRole("heading", { name: "Criar conta" })).toBeVisible();
  });

  test("a navegação rola até as seções e mostra o conteúdo", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Principal" }).getByRole("button", { name: "Segurança" }).click();
    await expect(page.locator("#seguranca")).toBeInViewport();
    await expect(page.getByText("Cada organização enxerga somente os próprios dados")).toBeVisible();
    await page.getByText("Já tenho minha base em planilhas").click();
    await expect(page.getByText("Quem já existe não é duplicado")).toBeVisible();
  });

  test("a documentação da API é pública", async ({ page }) => {
    await page.goto("/#/api");
    await expect(page).toHaveURL(/#\/api/);
    await expect(page.getByRole("heading", { name: /API/ }).first()).toBeVisible();
  });

  test("tema claro/escuro alterna e é lembrado depois de recarregar", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    // O botão cicla entre sistema → claro → escuro; chegamos ao escuro e conferimos a persistência.
    const toggle = page.getByRole("banner").getByRole("button", { name: /tema/i });
    for (let i = 0; i < 3 && (await html.getAttribute("data-theme")) !== "dark"; i++) await toggle.click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(13, 13, 15)");
  });
});

test.describe("login e cadastro (computador)", () => {
  test("tela dividida: painel de marca à esquerda e formulário à direita, sem quebrar", async ({ page }) => {
    await page.goto("/#/entrar");
    const aside = await page.locator(".auth-aside").boundingBox();
    const card = await page.locator(".auth-card").boundingBox();
    const vw = page.viewportSize()!.width;
    expect(aside!.width).toBeGreaterThan(vw * 0.4);
    expect(card!.x).toBeGreaterThan(aside!.x + aside!.width - 1);
    expect(card!.x + card!.width).toBeLessThanOrEqual(vw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("senha errada mostra erro claro e permanece na tela", async ({ page }) => {
    await page.goto("/#/entrar");
    await page.getByLabel("E-mail").fill("admin@demo.test");
    await passwordField(page).fill("senha-errada-123");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("E-mail ou senha incorretos");
    await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
  });

  test("o olho mostra e oculta a senha", async ({ page }) => {
    await page.goto("/#/entrar");
    const senha = passwordField(page);
    await senha.fill("segredo");
    await expect(senha).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Mostrar senha" }).click();
    await expect(senha).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Ocultar senha" }).click();
    await expect(senha).toHaveAttribute("type", "password");
  });

  test("recuperação de senha confirma sem revelar se o e-mail existe", async ({ page }) => {
    await page.goto("/#/entrar");
    await page.getByRole("button", { name: "Esqueci minha senha" }).click();
    await page.getByLabel("E-mail").fill("ninguem@nao-existe.test");
    await page.getByRole("button", { name: "Enviar link de recuperação" }).click();
    await expect(page.getByText("Se o e-mail estiver cadastrado")).toBeVisible();
  });

  test("cadastro cria a organização e entra no painel", async ({ page }) => {
    const email = `novo-${Date.now().toString(36)}@e2e.test`;
    await page.goto("/#/cadastro");
    await page.getByLabel("Seu nome").fill("Pessoa E2E");
    await page.getByLabel("Nome da administradora").fill("Administradora E2E");
    await page.getByLabel("E-mail").fill(email);
    await passwordField(page).fill("senha-e2e-12345");
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
    await expect(page.getByText("Administradora E2E").first()).toBeVisible();
    // Organização nova: painel vazio orienta o próximo passo.
    await expect(page.getByRole("button", { name: "Cadastrar imóvel" })).toBeVisible();
  });
});

test.describe("PWA", () => {
  test("manifesto, service worker e ícones são servidos; abre direto no login", async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const m = await manifest.json();
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/#/entrar");
    for (const icon of m.icons) expect((await request.get(icon.src)).ok(), icon.src).toBeTruthy();
    const sw = await request.get("/sw.js");
    expect(sw.ok()).toBeTruthy();
    expect(sw.headers()["cache-control"]).toContain("no-cache");
    expect((await request.get("/offline.html")).ok()).toBeTruthy();
  });

  test("o service worker nunca guarda respostas da API", async ({ request }) => {
    const sw = await (await request.get("/sw.js")).text();
    expect(sw).toMatch(/pathname\.startsWith\('\/api\/'\)\) return/);
  });
});
