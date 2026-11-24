import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { OWNER, TENANT, openPanel } from "./helpers";

/**
 * Acessibilidade automática (axe-core, WCAG 2.1 A/AA): nenhuma violação "grave" ou "crítica" nas telas principais, nos dois temas.
 * O axe só acha parte dos problemas (contraste, rótulos, papéis ARIA, nomes de botões…); não substitui teste com leitor de tela.
 */
async function scan(page: Page, name: string) {
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
  // O painel ilustrativo da home é uma imagem decorativa (role=img) com dados fictícios: fora da análise.
  const r = await new AxeBuilder({ page }).exclude(".mock").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const text = bad.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`).join("\n");
  expect(bad, `${name}\n${text}`).toEqual([]);
}

const menu = (page: Page) => page.getByRole("complementary", { name: "Menu principal" });
const goTo = async (page: Page, label: string) => {
  await menu(page).getByRole("button", { name: label, exact: true }).click();
  await page.waitForLoadState("networkidle");
};

test.describe("acessibilidade (axe)", () => {
  test("áreas públicas: home e login", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await scan(page, "home");
    await page.goto("/#/entrar");
    await expect(page.getByRole("button", { name: "Entrar", exact: true })).toBeVisible();
    await scan(page, "login");
  });

  for (const theme of ["dark", "light"] as const) {
    test(`painel da equipe (${theme})`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("ethos-theme", t), theme);
      await openPanel(page);
      await scan(page, `painel ${theme}`);
      for (const label of ["Financeiro", "Contratos", "Moradores e acessos", "Relatórios", "Captação", "Prestadores e preventiva", "Ocorrências", "Enquetes", "Documentos dos imóveis"]) {
        await goTo(page, label);
        await scan(page, `${label} (${theme})`);
      }
    });
  }

  test("meu perfil e área do inquilino/proprietário", async ({ page, browser }) => {
    await openPanel(page);
    await menu(page).getByRole("button", { name: /Meu perfil/ }).click();
    await expect(page.getByRole("heading", { name: "Meu perfil" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await scan(page, "meu perfil");

    const ctx = await browser.newContext();
    const t = await ctx.newPage();
    await openPanel(t, TENANT);
    await scan(t, "inquilino");
    for (const tab of ["Moradores", "Visitantes", "Encomendas", "Ocorrências", "Enquetes"]) {
      await t.getByRole("tab", { name: tab }).click();
      await t.waitForLoadState("networkidle");
      await scan(t, `inquilino > ${tab}`);
    }
    const o = await ctx.newPage();
    await openPanel(o, OWNER);
    await o.getByRole("tab", { name: "Resumo dos imóveis" }).click();
    await o.waitForLoadState("networkidle");
    await scan(o, "proprietário > resumo");
    await ctx.close();
  });
});
