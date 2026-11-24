import { test, expect, type Page } from "@playwright/test";
import { TENANT, openPanel, unique } from "./helpers";

const menu = (page: Page) => page.getByRole("complementary", { name: "Menu principal" });
const goTo = (page: Page, label: string) => menu(page).getByRole("button", { name: label, exact: true }).click();

/** Unidade do contrato vigente do inquilino logado em `tenantPage` (descoberta pela equipe em `staff`). */
async function tenantUnit(staff: Page, tenantPage: Page): Promise<number> {
  const leases = (await (await tenantPage.request.get("/api/portal/tenant/leases")).json()).items as { id: number; status: string }[];
  const id = leases.find((l) => l.status === "vigente")!.id;
  return (await (await staff.request.get(`/api/leases/${id}`)).json()).lease.unit_id as number;
}

test.describe("relatórios e financeiro 2", () => {
  test("relatórios abrem com dados e exportam CSV", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Relatórios");
    await expect(page.getByRole("heading", { name: "Relatórios" })).toBeVisible();
    await expect(page.getByText("Total em atraso")).toBeVisible();
    const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar CSV" }).click()]);
    expect(csv.suggestedFilename()).toBe("inadimplencia.csv");
    for (const tab of ["DRE por imóvel", "Fluxo de caixa", "DIMOB (apoio)"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    }
    await page.getByRole("tab", { name: "DRE por imóvel" }).click();
    await expect(page.getByText("Aluguéis recebidos").first()).toBeVisible();
  });

  test("conciliação: importa OFX e vê o lançamento; rateio e configurações", async ({ page }) => {
    await openPanel(page);
    await goTo(page, "Financeiro");
    await page.getByRole("tab", { name: "Conciliação" }).click();
    const memo = unique("DEPOSITO");
    const ofx = `<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240310120000<TRNAMT>123.45<FITID>${memo.replace(/\W/g, "")}<MEMO>${memo}</STMTTRN></BANKTRANLIST></OFX>`;
    await page.getByLabel("Escolher arquivo do extrato").setInputFiles({ name: "extrato.ofx", mimeType: "text/plain", buffer: Buffer.from(ofx) });
    await expect(page.getByText(/1 lançamento\(s\) lido\(s\)/)).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: memo })).toContainText("123,45");
    await page.getByRole("row").filter({ hasText: memo }).getByRole("button", { name: "Ignorar" }).click();
    await page.getByRole("tab", { name: "Ignorados" }).click();
    await expect(page.getByRole("row").filter({ hasText: memo })).toBeVisible();

    await page.getByRole("tab", { name: "Configurações" }).click();
    await page.getByRole("button", { name: "Alterar regras" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Multa por atraso (%)").fill("2");
    await dlg.getByLabel("Juros a cada 30 dias (%)").fill("1");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Regras salvas.")).toBeVisible();
    await expect(page.getByText("2% (uma vez)")).toBeVisible();
    await page.getByRole("button", { name: "Simular" }).click();
    await expect(page.getByText(/Seriam criados:/)).toBeVisible();
    // devolve ao padrão para não alterar os outros testes do demo
    await page.request.put("/api/settings/finance", { data: { late_fee_bps: 0, late_interest_bps: 0 } });

    await page.getByRole("tab", { name: "Rateio" }).click();
    await expect(page.getByRole("button", { name: "Novo rateio" })).toBeVisible();
  });
});

test.describe("captação e contratos", () => {
  test("interessado, agenda de visita e vitrine pública com formulário", async ({ page, browser }) => {
    await openPanel(page);
    await goTo(page, "Captação");
    await page.getByRole("button", { name: "Novo interessado" }).click();
    const name = unique("Interessado");
    let dlg = page.getByRole("dialog");
    await dlg.getByLabel("Nome", { exact: true }).fill(name);
    await dlg.getByLabel("Telefone").pressSequentially("11987654321");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText("(11) 98765-4321");
    await row.getByRole("button", { name: "Agendar visita" }).click();
    dlg = page.getByRole("dialog");
    const when = new Date(Date.now() + 3 * 86_400_000);
    when.setHours(15, 0, 0, 0);
    await dlg.getByLabel("Data e hora").fill(when.toISOString().slice(0, 16));
    await dlg.getByRole("button", { name: "Agendar" }).click();
    await expect(page.getByText("Visita agendada.")).toBeVisible();
    await page.getByRole("tab", { name: "Agenda de visitas" }).click();
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();

    await page.getByRole("tab", { name: "Vitrine pública" }).click();
    await page.getByRole("button", { name: "Ligar a vitrine" }).click();
    const link = await page.getByLabel("Link da vitrine").inputValue();
    const ctx = await browser.newContext();
    const pub = await ctx.newPage();
    await pub.goto(link);
    await expect(pub.getByRole("heading", { name: /Imóveis disponíveis/ })).toBeVisible();
    const lead = unique("Visitante do site");
    await pub.getByLabel("Nome", { exact: true }).fill(lead);
    await pub.getByLabel("Telefone (com DDD)").pressSequentially("11911112222");
    await pub.getByLabel(/Autorizo a administradora/).check();
    await pub.getByRole("button", { name: "Enviar" }).click();
    await expect(pub.getByText("Recebemos o seu contato.")).toBeVisible();
    await ctx.close();
    await page.getByRole("tab", { name: "Interessados" }).click();
    await expect(page.getByRole("row").filter({ hasText: lead })).toContainText("Site");
    await page.request.put("/api/settings/public-listing", { data: { enabled: false } });
  });

  test("aditivo de reajuste e garantia no contrato; coleta de assinatura e assinatura por link", async ({ page, browser }) => {
    await openPanel(page);
    const leases = (await (await page.request.get("/api/leases")).json()).items as { id: number; status: string }[];
    const lease = leases.find((l) => l.status === "vigente")!;
    await goTo(page, "Contratos");
    await page.getByRole("row").filter({ hasText: "Vigente" }).first().click();
    await expect(page.getByRole("heading", { name: "Aditivos, garantias e rescisão" })).toBeVisible();

    await page.getByRole("button", { name: "Renovar / reajustar / aditivo" }).click();
    let dlg = page.getByRole("dialog");
    await dlg.getByLabel("Reajuste (%)").fill("3");
    await dlg.getByRole("button", { name: "Emitir aditivo" }).click();
    await expect(page.getByText("Aditivo em vigor.")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Reajuste" }).first()).toBeVisible();
    // desfaz o reajuste para não alterar os valores esperados por outros testes
    const cur = (await (await page.request.get(`/api/leases/${lease.id}`)).json()).lease.rent_cents as number;
    await page.request.post(`/api/leases/${lease.id}/addenda`, { data: { kind: "reajuste", new_rent_cents: Math.round(cur / 1.03) } });

    await page.getByRole("button", { name: "Cadastrar garantia" }).click();
    dlg = page.getByRole("dialog");
    await dlg.getByLabel("Nome do fiador").fill("João Fiador");
    await dlg.getByLabel("CPF/CNPJ").fill("529.982.247-25");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Fiador" })).toContainText("João Fiador");

    // Assinatura: modelo + documento por API; coleta pela tela; assinatura pelo link, em outro navegador.
    const tpl = await (await page.request.post("/api/contract-templates", { data: { name: unique("Modelo"), body: "Contrato entre {{locador.nome}} e {{locatario.nome}}." } })).json();
    const doc = await (await page.request.post(`/api/leases/${lease.id}/documents`, { data: { templateId: tpl.item.id } })).json();
    await page.reload();
    await goTo(page, "Contratos");
    await page.getByRole("row").filter({ hasText: "Vigente" }).first().click();
    await page.getByRole("row").filter({ hasText: tpl.item.name }).getByRole("button", { name: "Assinaturas" }).click();
    dlg = page.getByRole("dialog");
    const signer = "Maria Teste Assinante";
    await dlg.getByLabel("Nome completo").fill(signer);
    await dlg.getByRole("button", { name: "Iniciar coleta" }).click();
    await expect(dlg.getByText("Links de assinatura")).toBeVisible();
    const started = await (await page.request.get(`/api/documents/${doc.document.id}/signature`)).json();
    expect(started.item.status).toBe("pendente");
    // o link só aparece uma vez; para o teste, cria outra coleta pela API e usa o link devolvido
    await page.request.post(`/api/documents/${doc.document.id}/signature/cancel`);
    const again = await (await page.request.post(`/api/documents/${doc.document.id}/signature`, { data: { signers: [{ name: signer, role: "locatario" }] } })).json();
    const ctx = await browser.newContext();
    const pub = await ctx.newPage();
    await pub.goto(again.links[0].link);
    await expect(pub.getByRole("heading", { name: tpl.item.name })).toBeVisible();
    await pub.getByLabel(/Digite o seu nome completo/).fill("Outro Nome");
    await pub.getByLabel(/Li o documento/).check();
    await pub.getByRole("button", { name: "Assinar" }).click();
    await expect(pub.getByRole("alert")).toContainText("Digite o seu nome completo");
    await pub.getByLabel(/Digite o seu nome completo/).fill(signer);
    await pub.getByRole("button", { name: "Assinar" }).click();
    await expect(pub.getByText("Assinatura registrada.")).toBeVisible();
    await ctx.close();
  });
});

test.describe("operação e portaria", () => {
  test("prestador, plano preventivo, enquete com voto do inquilino e ocorrência com contestação", async ({ page, browser }) => {
    await openPanel(page);
    await goTo(page, "Prestadores e preventiva");
    await page.getByRole("button", { name: "Novo prestador" }).click();
    let dlg = page.getByRole("dialog");
    const provider = unique("Eletricista");
    await dlg.getByLabel("Nome", { exact: true }).fill(provider);
    await dlg.getByLabel("Elétrica").check();
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByRole("row").filter({ hasText: provider })).toContainText("Elétrica");
    await page.getByRole("tab", { name: "Manutenção preventiva" }).click();
    await expect(page.getByRole("button", { name: "Novo plano" })).toBeVisible();

    // Enquete criada pela equipe e respondida pelo inquilino em outro navegador.
    await goTo(page, "Enquetes");
    await page.getByRole("button", { name: "Nova enquete" }).click();
    dlg = page.getByRole("dialog");
    const question = unique("Pintar o portão");
    await dlg.getByLabel("Pergunta").fill(question);
    await dlg.getByLabel(/Opções/).fill("Sim\nNão");
    await dlg.getByRole("button", { name: "Publicar" }).click();
    await expect(page.getByText(/Enquete publicada para/)).toBeVisible();
    const ctx = await browser.newContext();
    const t = await ctx.newPage();
    await openPanel(t, TENANT);
    await t.getByRole("tab", { name: "Enquetes" }).click();
    const card = t.locator(".panel").filter({ hasText: question });
    await card.getByRole("button", { name: "Sim" }).click();
    await expect(card.getByText("(seu voto)")).toBeVisible();

    // Ocorrência: registrar, notificar, inquilino contesta.
    await goTo(page, "Ocorrências");
    await page.getByRole("button", { name: "Registrar ocorrência" }).click();
    dlg = page.getByRole("dialog");
    const unitSel = dlg.getByLabel("Unidade");
    await unitSel.selectOption(String(await tenantUnit(page, t)));
    await dlg.getByLabel("Tipo").selectOption("barulho");
    await dlg.getByLabel("Quando aconteceu").fill(new Date(Date.now() - 3600_000).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 16).replace(" ", "T"));
    const what = unique("Música alta");
    await dlg.getByLabel("O que aconteceu").fill(what);
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await page.getByRole("row").filter({ hasText: "Registrada" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Notificar o morador" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: /Confirmar|Sim|OK|Notificar|Sim, notificar/ }).click();
    await t.reload();
    await t.getByRole("tab", { name: "Ocorrências" }).click();
    await t.getByRole("row").filter({ hasText: what }).getByRole("button", { name: "Contestar" }).click();
    await t.getByRole("dialog").getByLabel("Explique o seu lado").fill("Eu estava fora da cidade.");
    await t.getByRole("dialog").getByRole("button", { name: "Enviar contestação" }).click();
    await expect(t.getByText("Contestação enviada")).toBeVisible();
    await ctx.close();
  });

  test("portaria: registra encomenda e o inquilino vê; relatório de acessos abre", async ({ page, browser }) => {
    await openPanel(page);
    await goTo(page, "Moradores e acessos");
    await page.getByRole("tab", { name: "Encomendas" }).click();
    await page.getByRole("button", { name: "Registrar encomenda" }).click();
    const dlg = page.getByRole("dialog");
    const ctx = await browser.newContext();
    const t = await ctx.newPage();
    await openPanel(t, TENANT);
    const unit = await tenantUnit(page, t);
    await dlg.getByLabel("Unidade").selectOption(String(unit));
    const desc = unique("Caixa");
    await dlg.getByLabel("O que é").fill(desc);
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Encomenda registrada e morador avisado.")).toBeVisible();
    await t.getByRole("tab", { name: "Encomendas" }).click();
    await expect(t.getByRole("row").filter({ hasText: desc })).toContainText("Aguardando retirada");
    await page.getByRole("row").filter({ hasText: desc }).getByRole("button", { name: "Entregar" }).click();
    await page.getByRole("dialog").getByLabel("Quem retirou").fill("Filho do locatário");
    await page.getByRole("dialog").getByRole("button", { name: "Registrar entrega" }).click();
    await page.getByRole("tab", { name: "Relatório de acessos" }).click();
    await expect(page.getByText("Entradas no período")).toBeVisible();
    await ctx.close();
  });

  test("documentos dos imóveis: anexa PDF com vencimento", async ({ page }) => {
    await openPanel(page);
    const props = (await (await page.request.get("/api/properties")).json()).items as { id: number; name: string }[];
    await goTo(page, "Documentos dos imóveis");
    await page.getByLabel("Imóvel").selectOption(String(props[0]!.id));
    await page.getByLabel("Escolher arquivo").setInputFiles({ name: "seguro.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") });
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Tipo").selectOption("seguro");
    await dlg.getByLabel("Título").fill("Seguro incêndio E2E");
    const exp = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await dlg.getByLabel("Vencimento").fill(exp);
    await dlg.getByRole("button", { name: "Anexar" }).click();
    await expect(page.getByText("Documento anexado.")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Seguro incêndio E2E" }).first()).toBeVisible();
  });
});
