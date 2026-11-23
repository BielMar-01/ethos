import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect, type Page } from "@playwright/test";
import { createColaborador, openPanel, unique } from "./helpers";

const menu = (page: Page) => page.getByRole("complementary", { name: "Menu principal" });
const openIntegrations = async (page: Page) => {
  await openPanel(page);
  await menu(page).getByRole("button", { name: "Integrações", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Integrações", exact: true })).toBeVisible();
};
const card = (page: Page, title: string) => page.locator(".integration-card").filter({ hasText: title });

test.describe("integrações (admin)", () => {
  test("a aba existe só para administrador e mostra os quatro cartões", async ({ page, browser, request }) => {
    await openIntegrations(page);
    for (const t of ["Asaas", "IA — leitura de documentos", "Webhooks e automações", "Chaves de API"]) await expect(card(page, t)).toBeVisible();
    await expect(page.getByText("Em breve")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/_integrations.png" });

    const email = await createColaborador(request, page);
    const ctx = await browser.newContext();
    const colab = await ctx.newPage();
    await openPanel(colab, email);
    await expect(menu(colab).getByRole("button", { name: "Integrações", exact: true })).toHaveCount(0);
    expect((await ctx.request.get("/api/integrations")).status()).toBe(403);
    expect((await ctx.request.get("/api/webhooks")).status()).toBe(403);
    await ctx.close();
  });

  test("Asaas: salva a chave (cifrada, nunca devolvida), testa e desconecta", async ({ page }) => {
    await page.route("**/api/integrations/asaas/test", (route) => route.fulfill({ json: { ok: true, message: "Conectado ao Asaas (sandbox/testes)." } }));
    await openIntegrations(page);
    await card(page, "Asaas").getByRole("button", { name: "Conectar" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("heading", { name: "Asaas" })).toBeVisible();
    await dlg.getByLabel("Ambiente").selectOption("sandbox");
    await dlg.locator('input[autocomplete="off"]').fill("curta");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg.getByRole("alert")).toContainText("incompleta");
    await dlg.locator('input[autocomplete="off"]').fill("$aact_e2e_0000000000000000000000000000000000wxyz");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Configuração do Asaas salva.")).toBeVisible();
    await expect(dlg).toContainText("termina em …wxyz");
    // A chave inteira nunca volta do servidor.
    const body = await (await page.request.get("/api/integrations")).text();
    expect(body).not.toContain("aact_e2e");
    await dlg.getByRole("button", { name: "Testar conexão" }).click();
    await expect(page.getByText("Conectado ao Asaas (sandbox/testes).")).toBeVisible();
    await dlg.getByRole("button", { name: "Desconectar" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /Confirmar|Desconectar/ }).click();
    await expect(dlg).toHaveCount(0);
    await expect(card(page, "Asaas").getByText("Não conectado")).toBeVisible();
  });

  test("IA: escolhe entre vários provedores, valida a chave, define o principal e mostra no cartão", async ({ page }) => {
    await page.route("**/api/integrations/openai/test", (route) => route.fulfill({ json: { ok: true, message: "Conectado a OpenAI (GPT)." } }));
    await openIntegrations(page);
    await card(page, "IA — leitura").getByRole("button", { name: /Configurar|Gerenciar/ }).click();
    const dlg = page.getByRole("dialog");
    // Todos os provedores aparecem como abas.
    for (const nome of ["Anthropic", "OpenAI", "Google", "xAI", "DeepSeek", "Mistral", "Groq", "Together AI", "OpenRouter", "Outro"]) {
      await expect(dlg.getByRole("tab", { name: new RegExp("^" + nome) }), nome).toBeVisible();
    }
    // Anthropic: formato da chave é validado.
    await dlg.getByRole("tab", { name: /^Anthropic/ }).click();
    await dlg.locator('input[autocomplete="off"]').fill("chave-sem-prefixo-123456789012345");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg.getByRole("alert")).toContainText("sk-ant-");

    // DeepSeek avisa que só lê texto; OpenAI aceita modelo livre e vira o principal.
    await dlg.getByRole("tab", { name: /^DeepSeek/ }).click();
    await expect(dlg).toContainText("Não lê fotos (só texto)");
    await dlg.getByRole("tab", { name: /^OpenAI/ }).click();
    await expect(dlg).toContainText("lê PDF direto");
    await dlg.locator('input[autocomplete="off"]').fill("sk-e2e-0123456789abcdef");
    await dlg.getByPlaceholder("gpt-4.1").fill("gpt-4o-mini");
    await dlg.getByLabel("Usar este provedor para ler documentos").check();
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("OpenAI salvo.")).toBeVisible();
    await expect(dlg).toContainText("Em uso agora: OpenAI (GPT)");
    await expect(dlg).toContainText("termina em …cdef");
    const body = await (await page.request.get("/api/integrations")).text();
    expect(body).not.toContain("sk-e2e-0123");
    await dlg.getByRole("button", { name: "Testar conexão" }).click();
    await expect(page.getByText("Conectado a OpenAI (GPT).")).toBeVisible();

    // OpenRouter com ID de modelo no formato fabricante/modelo; modelo inválido é recusado.
    await dlg.getByRole("tab", { name: /^OpenRouter/ }).click();
    await dlg.locator('input[autocomplete="off"]').fill("sk-or-e2e-0123456789");
    await dlg.getByPlaceholder("openai/gpt-4o-mini").fill("modelo inválido;");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Nome de modelo inválido");
    await dlg.getByPlaceholder("openai/gpt-4o-mini").fill("google/gemini-2.5-flash");
    await dlg.getByLabel("Usar este provedor para ler documentos").check();
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg).toContainText("Em uso agora: OpenRouter");

    // "Outro" exige URL base.
    await dlg.getByRole("tab", { name: /^Outro/ }).click();
    await expect(dlg.getByLabel("URL base (https)")).toBeVisible();

    // Fecha e o cartão mostra o provedor em uso.
    await page.keyboard.press("Escape");
    await expect(card(page, "IA — leitura").getByText(/Em uso: OpenRouter/)).toBeVisible();
    // Deixa o demo limpo para os outros testes (que rodam em paralelo no mesmo servidor).
    for (const p of ["openai", "openrouter"]) await page.request.delete(`/api/integrations/${p}`);
  });

  test("Ler documentos mostra qual provedor está lendo e avisa quando só lê texto", async ({ page }) => {
    await page.route("**/api/extract/status", (route) =>
      route.fulfill({ json: { enabled: true, source: "organization", provider: { label: "DeepSeek", model: "deepseek-chat", images: false }, max_bytes: 4194304 } }),
    );
    await openPanel(page);
    await menu(page).getByRole("button", { name: "Ler documentos", exact: true }).click();
    await expect(page.getByText("Leitura feita por")).toContainText("DeepSeek");
    await expect(page.getByText("lê só texto")).toBeVisible();
  });

  test("webhook de ponta a ponta: cria pelo modal, recebe o segredo uma vez, testa e a entrega chega assinada", async ({ page }) => {
    const hits: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hits.push({ headers: req.headers, body });
        res.end("ok");
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    try {
      await openIntegrations(page);
      await card(page, "Webhooks").getByRole("button", { name: "Gerenciar" }).click();
      await page.getByRole("button", { name: "Novo endereço" }).click();
      const form = page.getByRole("dialog").last();
      const name = unique("n8n E2E");
      await form.getByLabel("Nome").fill(name);
      // (Em produção só https público é aceito — coberto nos testes de API; aqui o ambiente libera o receptor local.)
      await form.getByLabel("URL de destino").fill(url);
      await form.getByLabel(/Todos os eventos/).uncheck();
      await form.getByRole("button", { name: "Salvar" }).click();
      await expect(form.getByRole("alert")).toContainText("Escolha pelo menos um evento");
      await form.getByLabel(/Proprietário cadastrado/).check();
      await form.getByRole("button", { name: "Salvar" }).click();

      // O segredo aparece uma vez, em modal travado (Esc não fecha).
      const secretDlg = page.getByRole("dialog").last();
      await expect(secretDlg.getByRole("heading", { name: "Segredo de assinatura" })).toBeVisible();
      const secret = (await secretDlg.locator("code").first().textContent())!;
      expect(secret).toMatch(/^whsec_[0-9a-f]{48}$/);
      await page.keyboard.press("Escape");
      await expect(secretDlg).toBeVisible();
      await secretDlg.getByRole("button", { name: "Já copiei" }).click();

      // Testar: ping assinado chega ao receptor.
      const list = page.getByRole("dialog");
      const row = list.locator(".hook-list li").filter({ hasText: name });
      await row.getByRole("button", { name: "Testar" }).click();
      await expect(page.getByText(/respondeu HTTP 200/)).toBeVisible();
      const pings = () => hits.filter((h) => h.headers["x-ethos-event"] === "ping");
      expect(pings()).toHaveLength(1);
      const sig = /t=(\d+),v1=([0-9a-f]+)/.exec(String(pings()[0]!.headers["x-ethos-signature"]))!;
      expect(crypto.createHmac("sha256", secret).update(`${sig[1]}.${pings()[0]!.body}`).digest("hex")).toBe(sig[2]);

      // Evento real: cadastrar proprietário pela API dispara owner.created para o endereço.
      const owner = unique("Dono Webhook");
      await page.request.post("/api/owners", { data: { name: owner, document: String(Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)) } });
      const mine = () => hits.filter((h) => h.body.includes(owner));
      await expect.poll(() => mine().length).toBe(1);
      expect(mine()[0]!.headers["x-ethos-event"]).toBe("owner.created");
      expect(JSON.parse(mine()[0]!.body).data.item.name).toBe(owner);
      // Um evento não assinado (inquilino) não chega.
      const tenant = unique("Inq");
      await page.request.post("/api/tenants", { data: { name: tenant, document: String(Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)) } });
      await page.waitForTimeout(500);
      expect(hits.some((h) => h.body.includes(tenant))).toBe(false);

      // Histórico de entregas.
      await row.getByRole("button", { name: "Entregas" }).click();
      const log = page.getByRole("dialog").last();
      await expect(log.getByText("owner.created").first()).toBeVisible();
      await expect(log.getByText("ping", { exact: true }).first()).toBeVisible();
      await page.keyboard.press("Escape");

      // Pausar e excluir (com confirmação).
      await row.getByRole("button", { name: "Pausar" }).click();
      await expect(row.getByText("Pausado")).toBeVisible();
      await row.getByRole("button", { name: "Excluir" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Excluir" }).click();
      await expect(list.locator(".hook-list li").filter({ hasText: name })).toHaveCount(0);
    } finally {
      server.close();
    }
  });

  test("chaves de API ficam dentro de Integrações (modal) e a aba API aponta para lá", async ({ page }) => {
    await openIntegrations(page);
    await card(page, "Chaves de API").getByRole("button", { name: "Gerenciar" }).click();
    await page.getByRole("button", { name: "Nova chave" }).click();
    await page.getByRole("dialog").last().getByLabel("Nome da chave").fill(unique("chave n8n"));
    await page.getByRole("button", { name: "Criar chave" }).click();
    const shown = page.getByRole("dialog").last();
    await expect(shown.getByText("Copie agora: esta chave não será exibida novamente.")).toBeVisible();
    expect(await shown.locator("input[readonly]").inputValue()).toMatch(/^ethos_/);
    await shown.getByRole("button", { name: "Já copiei" }).click();
    await page.keyboard.press("Escape");
    await menu(page).getByRole("button", { name: "API", exact: true }).click();
    await expect(page.getByText("Administração › Integrações › Chaves de API")).toBeVisible();
  });
});
