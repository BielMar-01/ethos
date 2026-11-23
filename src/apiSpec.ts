/**
 * Contrato público da API (OpenAPI 3.0), gerado de um registro de endpoints.
 * Os exemplos usam um universo fictício coerente (Edifício Aurora, Carlos Almeida…): são MOCKS
 * ilustrativos, não dados reais. Um teste garante que todo endpoint listado aqui existe de fato.
 */

type Method = "get" | "post" | "put" | "patch" | "delete";

export interface Endpoint {
  tag: string;
  method: Method;
  path: string;
  summary: string;
  description?: string;
  /** Quem pode chamar. */
  access: "staff" | "admin" | "inquilino" | "proprietario" | "cliente" | "any";
  /** Aceita chave de API (somente leitura, age como colaborador)? */
  apiKey: boolean;
  query?: { name: string; description: string; example: string }[];
  requestExample?: unknown;
  status: number;
  responseExample?: unknown;
}

const ADDRESS = { street: "Rua das Flores", number: "100", neighborhood: "Centro", city: "São Paulo", state: "SP" };
const OWNER = { id: 1, name: "Maria Souza", document: "123.456.789-09", email: "maria@example.com", phone: "(11) 99999-0001" };
const TENANT = { id: 7, name: "Carlos Almeida", document: "987.654.321-00", email: "carlos@example.com", phone: "(11) 98888-0007" };
const PROPERTY = { id: 3, name: "Edifício Aurora", type: "apartamento", ...ADDRESS, zip: "01000-000" };
const UNIT = { id: 12, property_id: 3, identifier: "Apto 101", area_m2: 62, bedrooms: 2, rent_reference_cents: 250000, status: "ocupada" };
const LEASE = { id: 21, unit_id: 12, start_date: "2026-01-01", end_date: "2028-12-31", rent_cents: 250000, due_day: 5, guarantee: "Caução de três aluguéis", status: "vigente" };
const CHARGE = {
  id: 140, lease_id: 21, kind: "aluguel", description: "Aluguel 11/2026", competence: "2026-11-01", due_date: "2026-11-05",
  amount_cents: 250000, paid_cents: 250000, status: "paga", unit_identifier: "Apto 101", property_name: "Edifício Aurora", tenant_names: "Carlos Almeida",
};
const PAYMENT = {
  id: 88, lease_id: 21, received_at: "2026-11-04", amount_cents: 250000, method: "pix", reference: "E2E123", receipt_number: 57,
  voided_at: null, unit_identifier: "Apto 101", property_name: "Edifício Aurora", tenant_names: "Carlos Almeida",
};
const TRANSFER = { id: 9, owner_id: 1, owner_name: "Maria Souza", period: "2026-11-01", gross_cents: 250000, fee_cents: 25000, net_cents: 225000, fee_bps: 1000, status: "pago", paid_at: "2026-12-07" };

const list = (item: unknown) => ({ items: [item] });

export const ENDPOINTS: Endpoint[] = [
  // ---- Cadastros
  { tag: "Cadastros", method: "get", path: "/api/owners", summary: "Lista proprietários", access: "staff", apiKey: true, status: 200, responseExample: list(OWNER) },
  { tag: "Cadastros", method: "get", path: "/api/tenants", summary: "Lista inquilinos", access: "staff", apiKey: true, status: 200, responseExample: list(TENANT) },
  { tag: "Cadastros", method: "get", path: "/api/properties", summary: "Lista imóveis", access: "staff", apiKey: true, status: 200, responseExample: list(PROPERTY) },
  { tag: "Cadastros", method: "get", path: "/api/properties/{id}/owners", summary: "Proprietários de um imóvel", access: "staff", apiKey: true, status: 200, responseExample: list(OWNER) },
  { tag: "Cadastros", method: "get", path: "/api/units", summary: "Lista unidades locáveis", access: "staff", apiKey: true, status: 200, responseExample: list(UNIT) },
  { tag: "Cadastros", method: "get", path: "/api/units/{id}", summary: "Detalhe de uma unidade", access: "staff", apiKey: true, status: 200, responseExample: { item: UNIT } },
  {
    tag: "Cadastros", method: "post", path: "/api/properties", summary: "Cria um imóvel", access: "staff", apiKey: false, status: 201,
    requestExample: { name: "Edifício Aurora", type: "apartamento", ...ADDRESS, zip: "01000-000" }, responseExample: { item: PROPERTY },
  },
  // ---- Contratos
  { tag: "Contratos", method: "get", path: "/api/leases", summary: "Lista contratos de locação", access: "staff", apiKey: true, status: 200,
    responseExample: list({ id: 21, status: "vigente", start_date: "2026-01-01", end_date: "2028-12-31", rent_cents: 250000, due_day: 5, unit_id: 12, unit_identifier: "Apto 101", property_name: "Edifício Aurora", tenant_names: "Carlos Almeida" }) },
  { tag: "Contratos", method: "get", path: "/api/leases/{id}", summary: "Detalhe de um contrato", access: "staff", apiKey: true, status: 200,
    responseExample: { lease: LEASE, tenants: [{ id: 7, name: "Carlos Almeida", document: "987.654.321-00" }], unit: { id: 12, identifier: "Apto 101", property_id: 3, property_name: "Edifício Aurora" } } },
  { tag: "Contratos", method: "get", path: "/api/leases/{id}/documents", summary: "Documentos emitidos de um contrato", access: "staff", apiKey: true, status: 200,
    responseExample: list({ id: 5, template_name: "Locação residencial", template_version: 2, created_at: "2026-01-02T13:00:00Z", generated_by_name: "Ana Admin" }) },
  { tag: "Contratos", method: "get", path: "/api/documents/{id}", summary: "Documento emitido (texto final, imutável)", access: "staff", apiKey: true, status: 200,
    responseExample: { document: { id: 5, lease_id: 21, template_name: "Locação residencial", template_version: 2, content: "CONTRATO DE LOCAÇÃO…", created_at: "2026-01-02T13:00:00Z" } } },
  { tag: "Contratos", method: "get", path: "/api/contract-templates", summary: "Modelos de contrato", access: "staff", apiKey: true, status: 200,
    responseExample: list({ id: 2, name: "Locação residencial", body: "LOCADOR: {{locador.nome}}…", version: 2, updated_at: "2026-01-02T12:00:00Z" }) },
  { tag: "Contratos", method: "post", path: "/api/leases/{id}/status", summary: "Muda o status (rascunho→vigente→encerrado/rescindido)", access: "staff", apiKey: false, status: 200,
    requestExample: { status: "vigente" }, responseExample: { status: "vigente" } },
  // ---- Financeiro
  { tag: "Financeiro", method: "get", path: "/api/charges", summary: "Lista cobranças", description: "O status é derivado das baixas: aberta, parcial, vencida, paga ou cancelada.", access: "staff", apiKey: true, status: 200,
    query: [{ name: "month", description: "Mês de vencimento (AAAA-MM)", example: "2026-11" }, { name: "status", description: "Filtra pela situação", example: "vencida" }, { name: "lease_id", description: "Só de um contrato", example: "21" }],
    responseExample: list(CHARGE) },
  { tag: "Financeiro", method: "get", path: "/api/payments", summary: "Lista pagamentos recebidos", access: "staff", apiKey: true, status: 200,
    query: [{ name: "month", description: "Mês de recebimento (AAAA-MM)", example: "2026-11" }], responseExample: list(PAYMENT) },
  { tag: "Financeiro", method: "get", path: "/api/payments/{id}", summary: "Pagamento com baixas e texto do recibo", access: "staff", apiKey: true, status: 200,
    responseExample: { payment: { ...PAYMENT, receipt_content: "RECIBO Nº 57\n\nRecebemos de Carlos Almeida a quantia de R$ 2.500,00…" }, allocations: [{ charge_id: 140, amount_cents: 250000, description: "Aluguel 11/2026", due_date: "2026-11-05" }] } },
  { tag: "Financeiro", method: "get", path: "/api/transfers", summary: "Repasses a proprietários", access: "staff", apiKey: true, status: 200,
    query: [{ name: "period", description: "Mês dos recebimentos (AAAA-MM)", example: "2026-11" }], responseExample: list(TRANSFER) },
  { tag: "Financeiro", method: "get", path: "/api/finance/summary", summary: "Resumo do mês", access: "staff", apiKey: true, status: 200,
    query: [{ name: "month", description: "Mês (AAAA-MM) — obrigatório", example: "2026-11" }],
    responseExample: { month: "2026-11", expected_cents: 850000, received_cents: 722500, received_ratio: 85, overdue_cents: 127500, overdue_count: 2, cash_received_cents: 735000 } },
  { tag: "Financeiro", method: "post", path: "/api/charges/generate", summary: "Gera os aluguéis do mês (idempotente)", access: "staff", apiKey: false, status: 200,
    requestExample: { month: "2026-12" }, responseExample: { month: "2026-12", eligible: 3, created: 3, skipped: 0 } },
  { tag: "Financeiro", method: "post", path: "/api/payments", summary: "Registra pagamento e dá baixa nas cobranças", description: "A soma das baixas deve ser igual a amount_cents.", access: "staff", apiKey: false, status: 201,
    requestExample: { lease_id: 21, received_at: "2026-12-04", amount_cents: 250000, method: "pix", reference: "E2E123", allocations: [{ charge_id: 141, amount_cents: 250000 }] },
    responseExample: { payment: { id: 89, receipt_number: 58 } } },
  // ---- Manutenção
  { tag: "Manutenção", method: "get", path: "/api/maintenance", summary: "Lista chamados de manutenção", description: "Ordenados com os abertos e mais urgentes primeiro.", access: "staff", apiKey: true, status: 200,
    query: [{ name: "status", description: "aberta, em_analise, aguardando_aprovacao, aprovada, em_execucao, concluida ou cancelada", example: "em_execucao" }, { name: "unit_id", description: "Só de uma unidade", example: "12" }],
    responseExample: list({ id: 31, title: "Vazamento na pia", category: "hidraulica", priority: "alta", status: "em_execucao", unit_identifier: "Apto 101", property_name: "Edifício Aurora", assigned_name: "Ana Administradora", opened_by_name: "Carlos Almeida", cost_cents: null, quotes_count: 2, created_at: "2026-11-10T13:00:00Z" }) },
  { tag: "Manutenção", method: "get", path: "/api/maintenance/{id}", summary: "Chamado com orçamentos, linha do tempo e fotos", access: "staff", apiKey: true, status: 200,
    responseExample: { item: { id: 31, title: "Vazamento na pia", status: "aprovada", priority: "alta", description: "Pinga o tempo todo" }, quotes: [{ id: 4, supplier: "Hidro Ltda", amount_cents: 38000, status: "aprovado" }], updates: [{ id: 1, author_name: "Carlos Almeida", kind: "status", message: "Solicitação aberta pelo inquilino", client_visible: true }], photos: [{ id: 9, content_type: "image/jpeg", size_bytes: 184220 }] } },
  { tag: "Manutenção", method: "post", path: "/api/maintenance/{id}/status", summary: "Muda o status do chamado", description: "Fluxo: aberta → em_analise → aguardando_aprovacao → (aprovação de orçamento) → em_execucao → concluida. Cancelar exige `reason`; concluir aceita `cost_cents`.", access: "staff", apiKey: false, status: 200,
    requestExample: { status: "concluida", cost_cents: 38000 }, responseExample: { status: "concluida" } },
  // ---- Vistorias
  { tag: "Vistorias", method: "get", path: "/api/inspections", summary: "Lista vistorias", access: "staff", apiKey: true, status: 200,
    query: [{ name: "type", description: "entrada, saida ou periodica", example: "entrada" }, { name: "status", description: "agendada, em_andamento, concluida ou cancelada", example: "concluida" }],
    responseExample: list({ id: 6, type: "entrada", status: "concluida", scheduled_for: "2026-01-02", performed_at: "2026-01-02", unit_identifier: "Apto 101", property_name: "Edifício Aurora", inspector_name: "Ana Administradora", items_total: 27, items_done: 27 }) },
  { tag: "Vistorias", method: "get", path: "/api/inspections/{id}", summary: "Vistoria com checklist por ambiente, fotos e ciências", access: "staff", apiKey: true, status: 200,
    responseExample: { inspection: { id: 6, type: "entrada", status: "concluida", performed_at: "2026-01-02" }, items: [{ id: 41, room: "Sala", item: "Paredes", condition: "bom", notes: null, photos: [12] }], signatures: [{ role: "locatario", signer_name: "Carlos Almeida", signed_at: "2026-01-02T15:00:00Z" }] } },
  { tag: "Vistorias", method: "get", path: "/api/inspections/{id}/report", summary: "Laudo em texto", access: "staff", apiKey: true, status: 200,
    responseExample: { status: "concluida", report: "LAUDO DE VISTORIA DE ENTRADA\n\nImóvel: Edifício Aurora — unidade Apto 101…" } },
  { tag: "Vistorias", method: "get", path: "/api/inspections/{id}/compare/{otherId}", summary: "Compara duas vistorias concluídas da mesma unidade", description: "Aponta o que piorou, melhorou ou ficou igual (típico: entrada × saída).", access: "staff", apiKey: true, status: 200,
    responseExample: { first: { id: 6, type: "entrada" }, second: { id: 14, type: "saida" }, summary: { piorou: 2, melhorou: 0, igual: 25, so_na_primeira: 0, so_na_segunda: 0 }, items: [{ room: "Sala", item: "Paredes", change: "piorou", first: { condition: "bom" }, second: { condition: "ruim" } }] } },
  // ---- Painel
  { tag: "Painel", method: "get", path: "/api/dashboard", summary: "Visão geral da operação no mês atual", description: "Contagens (imóveis, unidades, contratos, chamados, vistorias), resumo financeiro do mês e a lista do que pede atenção agora.", access: "staff", apiKey: true, status: 200,
    responseExample: { month: "2026-11", counts: { properties: 2, owners: 2, tenants: 4, units: { total: 5, occupied: 4, available: 1 }, leases: { active: 4, ending_60d: 1 }, maintenance: { open: 2, urgent: 1, waiting_approval: 0 }, inspections_pending: 1 }, finance: { month: "2026-11", expected_cents: 850000, received_cents: 722500, received_ratio: 85, overdue_cents: 127500, overdue_count: 2, cash_received_cents: 735000 }, attention: [{ kind: "maintenance", title: "Infiltração no teto", detail: "Vila das Palmeiras · Casa 1", link_kind: "maintenance", link_id: 33 }] } },
  // ---- Comunicados e notificações
  { tag: "Comunicados e notificações", method: "get", path: "/api/announcements", summary: "Lista comunicados (rascunhos, publicados e arquivados)", access: "staff", apiKey: true, status: 200,
    responseExample: list({ id: 3, title: "Obras na fachada", audience: "inquilinos", property_name: null, status: "publicado", published_at: "2026-11-10T12:00:00Z", created_by_name: "Ana Administradora" }) },
  { tag: "Comunicados e notificações", method: "post", path: "/api/announcements", summary: "Cria um comunicado (rascunho)", description: "Público: `todos`, `inquilinos`, `proprietarios` ou `imovel` (exige `property_id`). Nada é enviado até publicar.", access: "staff", apiKey: false, status: 201,
    requestExample: { title: "Obras na fachada", body: "Entre os dias 10 e 20 haverá obra na fachada.", audience: "inquilinos" }, responseExample: { id: 3 } },
  { tag: "Comunicados e notificações", method: "post", path: "/api/announcements/{id}/publish", summary: "Publica o comunicado e notifica o público", description: "Só quem já está vinculado a um cadastro recebe. Publicar é irreversível (arquive para retirar).", access: "staff", apiKey: false, status: 200,
    responseExample: { recipients: 12, notified: 12 } },
  { tag: "Comunicados e notificações", method: "get", path: "/api/notifications", summary: "Minha caixa de entrada", description: "Notificações internas do usuário na organização atual. Categorias: financeiro, manutencao, vistoria, contrato, comunicado.", access: "any", apiKey: false, status: 200,
    query: [{ name: "unread", description: "1 = só não lidas", example: "1" }, { name: "limit", description: "Até 100", example: "20" }],
    responseExample: { unread: 2, items: [{ id: 51, category: "financeiro", kind: "payment_received", title: "Pagamento identificado", body: "R$ 2.500,00 · recibo nº 57", link_kind: "payment", link_id: 88, read_at: null, created_at: "2026-11-04T15:00:00Z" }] } },
  { tag: "Comunicados e notificações", method: "post", path: "/api/reminders/run", summary: "Gera os lembretes agora (vencimento próximo, atraso, fim de contrato)", description: "Idempotente. Também roda sozinho a cada 6 horas.", access: "admin", apiKey: false, status: 200,
    responseExample: { dueSoon: 3, overdue: 1, overdueDigest: 1, leasesEnding: 2 } },
  { tag: "Comunicados e notificações", method: "get", path: "/api/portal/announcements", summary: "Comunicados que se aplicam a mim", access: "cliente", apiKey: false, status: 200,
    responseExample: list({ id: 3, title: "Obras na fachada", body: "Entre os dias 10 e 20…", audience: "inquilinos", published_at: "2026-11-10T12:00:00Z", property_name: null }) },
  // ---- Área do cliente
  { tag: "Área do cliente — inquilino", method: "get", path: "/api/portal/tenant/maintenance", summary: "Meus chamados de manutenção", access: "inquilino", apiKey: false, status: 200,
    responseExample: list({ id: 31, title: "Vazamento na pia", category: "hidraulica", priority: "alta", status: "em_execucao", unit_identifier: "Apto 101", property_name: "Edifício Aurora" }) },
  { tag: "Área do cliente — inquilino", method: "post", path: "/api/portal/tenant/maintenance", summary: "Abre um chamado de manutenção", description: "Só para contrato vigente do próprio inquilino. A prioridade `urgente` é definida pela equipe.", access: "inquilino", apiKey: false, status: 201,
    requestExample: { lease_id: 21, category: "hidraulica", title: "Vazamento na pia", description: "Pinga o tempo todo", priority: "alta" }, responseExample: { id: 31 } },
  { tag: "Área do cliente — inquilino", method: "get", path: "/api/portal/tenant/inspections", summary: "Minhas vistorias concluídas", access: "inquilino", apiKey: false, status: 200,
    responseExample: list({ id: 6, type: "entrada", performed_at: "2026-01-02", unit_identifier: "Apto 101", property_name: "Edifício Aurora" }) },
  { tag: "Área do cliente — proprietário", method: "get", path: "/api/portal/owner/maintenance", summary: "Chamados dos meus imóveis", description: "O custo só aparece depois que o chamado é concluído.", access: "proprietario", apiKey: false, status: 200,
    responseExample: list({ id: 31, title: "Vazamento na pia", status: "concluida", cost_cents: 38000, unit_identifier: "Apto 101", property_name: "Edifício Aurora" }) },
  { tag: "Área do cliente — proprietário", method: "get", path: "/api/portal/owner/inspections", summary: "Vistorias concluídas dos meus imóveis", access: "proprietario", apiKey: false, status: 200,
    responseExample: list({ id: 6, type: "entrada", performed_at: "2026-01-02", unit_identifier: "Apto 101", property_name: "Edifício Aurora" }) },
  { tag: "Área do cliente — inquilino", method: "get", path: "/api/portal/tenant/leases", summary: "Meus contratos", access: "inquilino", apiKey: false, status: 200,
    responseExample: list({ id: 21, status: "vigente", start_date: "2026-01-01", end_date: "2028-12-31", rent_cents: 250000, due_day: 5, unit_identifier: "Apto 101", property_name: "Edifício Aurora", ...ADDRESS }) },
  { tag: "Área do cliente — inquilino", method: "get", path: "/api/portal/tenant/charges", summary: "Minhas cobranças", access: "inquilino", apiKey: false, status: 200,
    query: [{ name: "status", description: "aberta, parcial, vencida ou paga", example: "aberta" }],
    responseExample: list({ id: 141, kind: "aluguel", description: "Aluguel 12/2026", due_date: "2026-12-05", amount_cents: 250000, paid_cents: 0, status: "aberta" }) },
  { tag: "Área do cliente — inquilino", method: "get", path: "/api/portal/tenant/payments", summary: "Meus pagamentos e recibos", access: "inquilino", apiKey: false, status: 200,
    responseExample: list({ id: 88, received_at: "2026-11-04", amount_cents: 250000, method: "pix", receipt_number: 57, voided_at: null }) },
  { tag: "Área do cliente — inquilino", method: "get", path: "/api/portal/tenant/documents", summary: "Contratos emitidos para mim", access: "inquilino", apiKey: false, status: 200,
    responseExample: list({ id: 5, lease_id: 21, template_name: "Locação residencial", template_version: 2, created_at: "2026-01-02T13:00:00Z" }) },
  { tag: "Área do cliente — proprietário", method: "get", path: "/api/portal/owner/properties", summary: "Meus imóveis", access: "proprietario", apiKey: false, status: 200,
    responseExample: list({ id: 3, name: "Edifício Aurora", type: "apartamento", ...ADDRESS, units_total: 8, units_occupied: 7 }) },
  { tag: "Área do cliente — proprietário", method: "get", path: "/api/portal/owner/units", summary: "Minhas unidades e contrato vigente", access: "proprietario", apiKey: false, status: 200,
    responseExample: list({ id: 12, identifier: "Apto 101", status: "ocupada", property_name: "Edifício Aurora", lease_id: 21, rent_cents: 250000, tenant_names: "Carlos Almeida" }) },
  { tag: "Área do cliente — proprietário", method: "get", path: "/api/portal/owner/transfers", summary: "Meus repasses", access: "proprietario", apiKey: false, status: 200,
    responseExample: list({ id: 9, period: "2026-11-01", gross_cents: 250000, fee_cents: 25000, net_cents: 225000, fee_bps: 1000, status: "pago", paid_at: "2026-12-07" }) },
];

const ACCESS_TEXT: Record<Endpoint["access"], string> = {
  staff: "Administrador ou colaborador (sessão)",
  admin: "Somente administrador (sessão)",
  inquilino: "Somente inquilino (sessão)",
  proprietario: "Somente proprietário (sessão)",
  cliente: "Inquilino ou proprietário (sessão)",
  any: "Qualquer usuário autenticado (sessão); chaves de API não têm caixa de entrada",
};

/** Monta o documento OpenAPI 3.0.3. */
export function buildOpenApi(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of ENDPOINTS) {
    const pathParams = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1]!, in: "path", required: true, schema: { type: "integer" }, example: 1,
    }));
    const queryParams = (e.query ?? []).map((q) => ({
      name: q.name, in: "query", required: false, description: q.description, schema: { type: "string" }, example: q.example,
    }));
    (paths[e.path] ??= {})[e.method] = {
      tags: [e.tag],
      summary: e.summary,
      description: [
        e.description,
        `**Acesso:** ${ACCESS_TEXT[e.access]}${e.access === "staff" && e.apiKey ? " — leitura também por chave de API" : ""}.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      security: e.apiKey ? [{ ApiKey: [] }, { Session: [] }] : [{ Session: [] }],
      parameters: [...pathParams, ...queryParams],
      ...(e.requestExample === undefined
        ? {}
        : { requestBody: { required: true, content: { "application/json": { schema: { type: "object" }, example: e.requestExample } } } }),
      responses: {
        [e.status]: {
          description: "Sucesso (exemplo ilustrativo)",
          content: e.responseExample === undefined ? undefined : { "application/json": { schema: { type: "object" }, example: e.responseExample } },
        },
        "401": { description: "Não autenticado" },
        "403": { description: "Sem permissão para este papel" },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Ethos API",
      version: "1.0.0",
      description:
        "API da plataforma Ethos de administração de imóveis. Todos os valores monetários são **inteiros em centavos**; datas são `AAAA-MM-DD`. " +
        "Os dados de exemplo são fictícios. Chaves de API são **somente leitura** e enxergam apenas a organização que as criou.",
    },
    servers: [{ url: serverUrl }],
    tags: [...new Set(ENDPOINTS.map((e) => e.tag))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        ApiKey: { type: "http", scheme: "bearer", description: "Chave criada em API › Chaves de API. Envie `Authorization: Bearer ethos_...`." },
        Session: { type: "apiKey", in: "cookie", name: "ethos_sid", description: "Cookie de sessão obtido em POST /api/auth/login." },
      },
    },
    paths,
  };
}
