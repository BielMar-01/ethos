import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { background } from "./background.js";
import { emitWebhook, eventFor } from "./webhooks.js";

export type AuditKind = "create" | "update" | "delete" | "action" | "auth" | "denied" | "system";

export interface AuditEntry {
  organizationId: number;
  userId?: number | null;
  userName?: string | null;
  userEmail?: string | null;
  role?: string | null;
  kind: AuditKind;
  entity?: string | null;
  entityId?: number | null;
  summary: string;
  status?: number | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Grava um evento. NUNCA lança: falha de auditoria não pode derrubar a ação do usuário (vai para o log do servidor). */
export async function recordAudit(e: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_name, user_email, role, kind, entity, entity_id,
                               summary, status, metadata, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
      [
        e.organizationId,
        e.userId ?? null,
        e.userName ?? null,
        e.userEmail ?? null,
        e.role ?? null,
        e.kind,
        e.entity ?? null,
        e.entityId ?? null,
        e.summary.slice(0, 500),
        e.status ?? null,
        JSON.stringify(e.metadata ?? {}),
        e.ip ?? null,
        e.userAgent?.slice(0, 300) ?? null,
      ],
    );
  } catch (err) {
    console.error("Falha ao gravar auditoria:", err instanceof Error ? err.message : err);
  }
}

/** Dados da requisição que vão em todo evento (quem chamou e de onde). */
export function requestInfo(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

// ---------------------------------------------------------------------------------------------
// Registro automático de TODA escrita bem-sucedida (e de toda negação 403) sem tocar em cada rota.
// ---------------------------------------------------------------------------------------------

const ENTITY: Record<string, string> = {
  owners: "proprietário",
  tenants: "inquilino",
  properties: "imóvel",
  units: "unidade",
  leases: "contrato",
  "contract-templates": "modelo de contrato",
  charges: "cobrança",
  payments: "pagamento",
  boletos: "boleto",
  transfers: "repasse",
  settings: "configuração",
  maintenance: "chamado de manutenção",
  inspections: "vistoria",
  photos: "foto",
  announcements: "comunicado",
  members: "membro da equipe",
  invitations: "convite",
  "api-keys": "chave de API",
  reminders: "lembretes",
  notifications: "notificações",
  residents: "morador",
  visitors: "visitante",
  profile: "perfil",
  portal: "área do cliente",
  auth: "sessão",
};

interface Rule {
  method: string;
  /** Caminho normalizado: ids numéricos viram :id e o token de convite vira :token. */
  path: RegExp;
  kind: AuditKind;
  summary: string;
  /** Evento de webhook (só as regras com evento explícito saem do sistema). */
  event?: string;
}

const rules: Rule[] = [
  { method: "POST", path: /^\/api\/leases\/:id\/status$/, kind: "action", summary: "Mudou o status do contrato", event: "lease.status_changed" },
  { method: "POST", path: /^\/api\/leases\/:id\/documents$/, kind: "create", summary: "Emitiu documento de contrato" },
  { method: "POST", path: /^\/api\/leases\/:id\/files$/, kind: "create", summary: "Anexou documento ao contrato" },
  { method: "DELETE", path: /^\/api\/lease-files\/:id$/, kind: "delete", summary: "Excluiu anexo de contrato" },
  { method: "POST", path: /^\/api\/contract-templates\/read-file$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/contract-templates\/:id\/default$/, kind: "update", summary: "Definiu o modelo padrão de contrato" },
  { method: "POST", path: /^\/api\/leases\/:id\/document-data$/, kind: "update", summary: "Completou dados que faltavam para o contrato" },
  { method: "POST", path: /^\/api\/leases\/:id\/preview$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/charges\/generate$/, kind: "action", summary: "Gerou cobranças do mês", event: "charges.generated" },
  { method: "POST", path: /^\/api\/charges\/:id\/cancel$/, kind: "action", summary: "Cancelou cobrança", event: "charge.cancelled" },
  { method: "POST", path: /^\/api\/boletos$/, kind: "create", summary: "Emitiu boleto", event: "boleto.created" },
  { method: "POST", path: /^\/api\/boletos\/manual$/, kind: "create", summary: "Registrou boleto manual", event: "boleto.created" },
  { method: "POST", path: /^\/api\/boletos\/manual\/bulk$/, kind: "action", summary: "Gerou boletos manuais em lote", event: "boletos.generated" },
  { method: "PATCH", path: /^\/api\/boletos\/:id$/, kind: "update", summary: "Alterou boleto manual" },
  { method: "POST", path: /^\/api\/boletos\/:id\/paid$/, kind: "action", summary: "Marcou boleto como pago" },
  { method: "POST", path: /^\/api\/boletos\/bulk$/, kind: "action", summary: "Emitiu boletos em lote", event: "boletos.generated" },
  { method: "POST", path: /^\/api\/boletos\/paid-bulk$/, kind: "action", summary: "Deu baixa em boletos em lote", event: "boletos.paid" },
  { method: "POST", path: /^\/api\/leases\/:id\/carne$/, kind: "action", summary: "Gerou o carnê do contrato", event: "boletos.generated" },
  { method: "POST", path: /^\/api\/boletos\/:id\/resend$/, kind: "action", summary: "Reenviou a segunda via do boleto" },
  { method: "POST", path: /^\/api\/boletos\/sync$/, kind: "action", summary: "Atualizou a situação dos boletos" },
  { method: "POST", path: /^\/api\/boletos\/:id\/sync$/, kind: "action", summary: "Atualizou a situação de um boleto" },
  { method: "POST", path: /^\/api\/boletos\/:id\/cancel$/, kind: "action", summary: "Cancelou boleto", event: "boleto.cancelled" },
  { method: "POST", path: /^\/api\/visitors$/, kind: "create", summary: "Autorizou visitante" },
  { method: "POST", path: /^\/api\/portal\/tenant\/visitors$/, kind: "create", summary: "Autorizou visitante (inquilino)" },
  { method: "PUT", path: /^\/api\/(portal\/tenant\/)?visitors\/:id$/, kind: "update", summary: "Alterou autorização de visitante" },
  { method: "POST", path: /^\/api\/(portal\/tenant\/)?visitors\/:id\/cancel$/, kind: "action", summary: "Cancelou autorização de visitante" },
  { method: "POST", path: /^\/api\/(portal\/tenant\/)?visitors\/:id\/renew$/, kind: "action", summary: "Renovou autorização de visitante" },
  { method: "PUT", path: /^\/api\/visitors\/:id\/photo$/, kind: "update", summary: "Registrou foto de visitante" },
  { method: "DELETE", path: /^\/api\/visitors\/:id\/photo$/, kind: "delete", summary: "Removeu foto de visitante" },
  { method: "POST", path: /^\/api\/parcels$/, kind: "create", summary: "Registrou encomenda na portaria" },
  { method: "POST", path: /^\/api\/parcels\/:id\/pickup$/, kind: "action", summary: "Registrou retirada de encomenda" },
  { method: "POST", path: /^\/api\/parcels\/:id\/return$/, kind: "action", summary: "Registrou devolução de encomenda" },
  { method: "POST", path: /^\/api\/visitors\/:id\/block$/, kind: "action", summary: "Bloqueou visitante" },
  { method: "POST", path: /^\/api\/visitors\/:id\/unblock$/, kind: "action", summary: "Desbloqueou visitante" },
  { method: "POST", path: /^\/api\/visitors\/:id\/entry$/, kind: "action", summary: "Registrou entrada de visitante", event: "visitor.entered" },
  { method: "POST", path: /^\/api\/visitors\/:id\/exit$/, kind: "action", summary: "Registrou saída de visitante", event: "visitor.left" },
  { method: "POST", path: /^\/api\/portal\/tenant\/residents$/, kind: "create", summary: "Cadastrou morador (inquilino)" },
  { method: "PUT", path: /^\/api\/(portal\/tenant\/)?residents\/:id$/, kind: "update", summary: "Alterou morador" },
  { method: "POST", path: /^\/api\/(portal\/tenant\/)?residents\/:id\/move-out$/, kind: "action", summary: "Registrou a saída de um morador" },
  { method: "PUT", path: /^\/api\/profile$/, kind: "update", summary: "Atualizou o próprio perfil" },
  { method: "POST", path: /^\/api\/profile\/email$/, kind: "auth", summary: "Alterou o próprio e-mail" },
  { method: "POST", path: /^\/api\/profile\/password$/, kind: "auth", summary: "Alterou a própria senha" },
  { method: "POST", path: /^\/api\/profile\/sessions\/logout-others$/, kind: "auth", summary: "Encerrou as outras sessões" },
  { method: "DELETE", path: /^\/api\/profile\/sessions\/[0-9a-f]{16}$/, kind: "auth", summary: "Encerrou uma sessão de outro aparelho" },
  { method: "PUT", path: /^\/api\/profile\/avatar$/, kind: "update", summary: "Alterou a própria foto de perfil" },
  { method: "DELETE", path: /^\/api\/profile\/avatar$/, kind: "update", summary: "Removeu a própria foto de perfil" },
  { method: "POST", path: /^\/api\/profile\/mfa\/setup$/, kind: "auth", summary: "Iniciou a configuração da verificação em duas etapas" },
  { method: "POST", path: /^\/api\/profile\/mfa\/enable$/, kind: "auth", summary: "Ativou a verificação em duas etapas" },
  { method: "POST", path: /^\/api\/profile\/mfa\/disable$/, kind: "auth", summary: "Desativou a verificação em duas etapas" },
  { method: "POST", path: /^\/api\/profile\/mfa\/recovery-codes$/, kind: "auth", summary: "Gerou novos códigos de recuperação" },
  { method: "POST", path: /^\/api\/profile\/delete$/, kind: "auth", summary: "Encerrou a própria conta" },
  { method: "POST", path: /^\/api\/members\/:id\/mfa-reset$/, kind: "auth", summary: "Desativou a verificação em duas etapas de um membro" },
  { method: "POST", path: /^\/api\/auth\/mfa$/, kind: "auth", summary: "Entrou no sistema (verificação em duas etapas)" },
  { method: "POST", path: /^\/api\/auth\/passkey\/verify$/, kind: "auth", summary: "Entrou no sistema (passkey)" },
  { method: "POST", path: /^\/api\/auth\/oauth$/, kind: "auth", summary: "Entrou no sistema (login social)" },
  { method: "POST", path: /^\/api\/profile\/passkeys\/verify$/, kind: "auth", summary: "Cadastrou uma passkey" },
  { method: "DELETE", path: /^\/api\/profile\/passkeys\/[\w-]+$/, kind: "auth", summary: "Removeu uma passkey" },
  { method: "DELETE", path: /^\/api\/profile\/email$/, kind: "auth", summary: "Cancelou a troca de e-mail pendente" },
  { method: "PUT", path: /^\/api\/profile\/security$/, kind: "auth", summary: "Alterou os países permitidos para entrar" },
  { method: "PUT", path: /^\/api\/settings\/security$/, kind: "update", summary: "Alterou a segurança da organização" },
  { method: "PUT", path: /^\/api\/notifications\/whatsapp-consent$/, kind: "update", summary: "Alterou o consentimento de WhatsApp" },
  { method: "POST", path: /^\/api\/push\/(subscribe|unsubscribe)$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/charges\/late-fees\/run$/, kind: "action", summary: "Aplicou multa e juros por atraso" },
  { method: "POST", path: /^\/api\/bank\/import$/, kind: "action", summary: "Importou extrato bancário" },
  { method: "POST", path: /^\/api\/bank\/lines\/:id\/reconcile$/, kind: "action", summary: "Conciliou um lançamento do extrato" },
  { method: "POST", path: /^\/api\/bank\/lines\/:id\/(ignore|restore)$/, kind: "update", summary: "Alterou a situação de um lançamento do extrato" },
  { method: "POST", path: /^\/api\/shared-expenses$/, kind: "create", summary: "Criou rateio de despesa" },
  { method: "POST", path: /^\/api\/shared-expenses\/:id\/cancel$/, kind: "action", summary: "Cancelou rateio de despesa" },
  { method: "POST", path: /^\/api\/leases\/:id\/addenda$/, kind: "action", summary: "Emitiu aditivo de contrato", event: "lease.addendum" },
  { method: "POST", path: /^\/api\/leases\/:id\/terminate\/preview$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/leases\/:id\/terminate$/, kind: "action", summary: "Rescindiu contrato", event: "lease.terminated" },
  { method: "POST", path: /^\/api\/leases\/:id\/guarantees$/, kind: "create", summary: "Cadastrou garantia do contrato" },
  { method: "PATCH", path: /^\/api\/guarantees\/:id$/, kind: "update", summary: "Alterou garantia do contrato" },
  { method: "DELETE", path: /^\/api\/guarantees\/:id$/, kind: "delete", summary: "Excluiu garantia do contrato" },
  { method: "POST", path: /^\/api\/documents\/:id\/signature$/, kind: "action", summary: "Iniciou coleta de assinaturas" },
  { method: "POST", path: /^\/api\/documents\/:id\/signature\/cancel$/, kind: "action", summary: "Cancelou coleta de assinaturas" },
  { method: "POST", path: /^\/api\/sign\/[\w-]+$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/leads$/, kind: "create", summary: "Cadastrou interessado" },
  { method: "PATCH", path: /^\/api\/leads\/:id$/, kind: "update", summary: "Alterou interessado" },
  { method: "POST", path: /^\/api\/leads\/:id\/visits$/, kind: "create", summary: "Agendou visita a interessado" },
  { method: "PATCH", path: /^\/api\/lead-visits\/:id$/, kind: "update", summary: "Alterou visita agendada" },
  { method: "POST", path: /^\/api\/public\/interest$/, kind: "system", summary: "" },
  { method: "PUT", path: /^\/api\/settings\/public-listing$/, kind: "update", summary: "Alterou a vitrine pública de imóveis" },
  { method: "POST", path: /^\/api\/credit-checks$/, kind: "create", summary: "Registrou análise de crédito" },
  { method: "PATCH", path: /^\/api\/credit-checks\/:id\/decision$/, kind: "action", summary: "Decidiu análise de crédito" },
  { method: "POST", path: /^\/api\/properties\/:id\/documents$/, kind: "create", summary: "Anexou documento ao imóvel" },
  { method: "PATCH", path: /^\/api\/property-documents\/:id$/, kind: "update", summary: "Alterou documento do imóvel" },
  { method: "DELETE", path: /^\/api\/property-documents\/:id$/, kind: "delete", summary: "Excluiu documento do imóvel" },
  { method: "POST", path: /^\/api\/providers$/, kind: "create", summary: "Cadastrou prestador" },
  { method: "PATCH", path: /^\/api\/providers\/:id$/, kind: "update", summary: "Alterou prestador" },
  { method: "DELETE", path: /^\/api\/providers\/:id$/, kind: "delete", summary: "Excluiu prestador" },
  { method: "POST", path: /^\/api\/providers\/:id\/reviews$/, kind: "create", summary: "Avaliou prestador" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes\/:id\/provider$/, kind: "update", summary: "Vinculou orçamento a um prestador" },
  { method: "POST", path: /^\/api\/maintenance-plans$/, kind: "create", summary: "Criou plano de manutenção preventiva" },
  { method: "PATCH", path: /^\/api\/maintenance-plans\/:id$/, kind: "update", summary: "Alterou plano de manutenção preventiva" },
  { method: "DELETE", path: /^\/api\/maintenance-plans\/:id$/, kind: "delete", summary: "Excluiu plano de manutenção preventiva" },
  { method: "POST", path: /^\/api\/polls$/, kind: "create", summary: "Criou enquete" },
  { method: "POST", path: /^\/api\/polls\/:id\/close$/, kind: "action", summary: "Encerrou enquete" },
  { method: "DELETE", path: /^\/api\/polls\/:id$/, kind: "delete", summary: "Excluiu enquete" },
  { method: "POST", path: /^\/api\/portal\/polls\/:id\/vote$/, kind: "system", summary: "" },
  { method: "POST", path: /^\/api\/incidents$/, kind: "create", summary: "Registrou ocorrência" },
  { method: "POST", path: /^\/api\/incidents\/:id\/notify$/, kind: "action", summary: "Notificou o morador sobre ocorrência" },
  { method: "POST", path: /^\/api\/incidents\/:id\/fine$/, kind: "action", summary: "Aplicou multa por ocorrência" },
  { method: "POST", path: /^\/api\/incidents\/:id\/archive$/, kind: "action", summary: "Arquivou ocorrência" },
  { method: "POST", path: /^\/api\/portal\/tenant\/incidents\/:id\/contest$/, kind: "action", summary: "Contestou ocorrência (inquilino)" },
  { method: "DELETE", path: /^\/api\/admin\/errors$/, kind: "delete", summary: "Limpou o registro de erros do sistema" },
  { method: "POST", path: /^\/api\/payments$/, kind: "create", summary: "Registrou pagamento", event: "payment.received" },
  { method: "POST", path: /^\/api\/payments\/:id\/void$/, kind: "action", summary: "Estornou pagamento", event: "payment.voided" },
  { method: "POST", path: /^\/api\/transfers\/generate$/, kind: "action", summary: "Gerou repasses do mês" },
  { method: "POST", path: /^\/api\/transfers\/:id\/pay$/, kind: "action", summary: "Marcou repasse como pago", event: "transfer.paid" },
  { method: "PUT", path: /^\/api\/settings\/finance$/, kind: "update", summary: "Alterou a taxa de administração" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/status$/, kind: "action", summary: "Mudou o status do chamado", event: "maintenance.status_changed" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/comments$/, kind: "create", summary: "Comentou em chamado" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/photos$/, kind: "create", summary: "Anexou foto ao chamado" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes$/, kind: "create", summary: "Registrou orçamento" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes\/:id\/approve$/, kind: "action", summary: "Aprovou orçamento" },
  { method: "POST", path: /^\/api\/maintenance\/:id\/quotes\/:id\/reject$/, kind: "action", summary: "Recusou orçamento" },
  { method: "POST", path: /^\/api\/inspections\/:id\/status$/, kind: "action", summary: "Mudou o status da vistoria", event: "inspection.status_changed" },
  { method: "POST", path: /^\/api\/inspections\/:id\/items$/, kind: "create", summary: "Adicionou item à vistoria" },
  { method: "POST", path: /^\/api\/inspections\/:id\/items\/:id\/photos$/, kind: "create", summary: "Anexou foto à vistoria" },
  { method: "DELETE", path: /^\/api\/inspections\/:id\/items\/:id$/, kind: "delete", summary: "Removeu item da vistoria" },
  { method: "PATCH", path: /^\/api\/inspections\/:id\/items\/:id$/, kind: "update", summary: "Avaliou item da vistoria" },
  { method: "POST", path: /^\/api\/inspections\/:id\/signatures$/, kind: "action", summary: "Registrou ciência da vistoria" },
  { method: "POST", path: /^\/api\/portal\/(tenant|owner)\/inspections\/:id\/sign$/, kind: "action", summary: "Registrou ciência da vistoria" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance$/, kind: "create", summary: "Abriu chamado de manutenção", event: "maintenance.created" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance\/:id\/cancel$/, kind: "action", summary: "Cancelou o próprio chamado" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance\/:id\/comments$/, kind: "create", summary: "Comentou no próprio chamado" },
  { method: "POST", path: /^\/api\/portal\/tenant\/maintenance\/:id\/photos$/, kind: "create", summary: "Anexou foto ao próprio chamado" },
  { method: "POST", path: /^\/api\/announcements\/:id\/publish$/, kind: "action", summary: "Publicou comunicado", event: "announcement.published" },
  { method: "POST", path: /^\/api\/announcements\/:id\/archive$/, kind: "action", summary: "Arquivou comunicado" },
  { method: "POST", path: /^\/api\/members\/:id\/password-reset$/, kind: "action", summary: "Redefiniu a senha de um membro" },
  { method: "POST", path: /^\/api\/invitations\/by-token\/:token\/accept$/, kind: "auth", summary: "Aceitou um convite" },
  { method: "PUT", path: /^\/api\/settings\/company$/, kind: "update", summary: "Atualizou os dados da empresa (contratos)" },
  { method: "POST", path: /^\/api\/invitations$/, kind: "create", summary: "Criou convite" },
  { method: "POST", path: /^\/api\/invitations\/:id\/resend$/, kind: "action", summary: "Reenviou convite" },
  { method: "DELETE", path: /^\/api\/invitations\/:id$/, kind: "delete", summary: "Cancelou convite" },
  { method: "PATCH", path: /^\/api\/members\/:id$/, kind: "update", summary: "Alterou o papel de um membro" },
  { method: "DELETE", path: /^\/api\/members\/:id$/, kind: "delete", summary: "Removeu um membro da equipe" },
  { method: "POST", path: /^\/api\/api-keys$/, kind: "create", summary: "Criou chave de API" },
  { method: "DELETE", path: /^\/api\/api-keys\/:id$/, kind: "delete", summary: "Revogou chave de API" },
  { method: "POST", path: /^\/api\/reminders\/run$/, kind: "action", summary: "Executou os lembretes manualmente" },
  { method: "PUT", path: /^\/api\/properties\/:id\/owners$/, kind: "update", summary: "Alterou os proprietários do imóvel" },
  { method: "POST", path: /^\/api\/auth\/logout$/, kind: "auth", summary: "Saiu do sistema" },
  { method: "POST", path: /^\/api\/auth\/switch$/, kind: "auth", summary: "Trocou de organização" },
  { method: "POST", path: /^\/api\/auth\/login$/, kind: "auth", summary: "Entrou no sistema" },
  { method: "POST", path: /^\/api\/auth\/register$/, kind: "auth", summary: "Criou a organização e a conta" },
  { method: "DELETE", path: /^\/api\/photos\/:id$/, kind: "delete", summary: "Removeu foto" },
  { method: "PUT", path: /^\/api\/integrations\/\w+$/, kind: "update", summary: "Configurou uma integração" },
  { method: "DELETE", path: /^\/api\/integrations\/\w+$/, kind: "delete", summary: "Desconectou uma integração" },
  { method: "POST", path: /^\/api\/integrations\/\w+\/test$/, kind: "action", summary: "Testou a conexão de uma integração" },
  { method: "POST", path: /^\/api\/webhooks$/, kind: "create", summary: "Criou um endereço de webhook" },
  { method: "PATCH", path: /^\/api\/webhooks\/:id$/, kind: "update", summary: "Alterou um endereço de webhook" },
  { method: "DELETE", path: /^\/api\/webhooks\/:id$/, kind: "delete", summary: "Excluiu um endereço de webhook" },
  { method: "POST", path: /^\/api\/webhooks\/:id\/rotate-secret$/, kind: "action", summary: "Gerou novo segredo de webhook" },
  { method: "POST", path: /^\/api\/webhooks\/:id\/test$/, kind: "action", summary: "Testou um endereço de webhook" },
];

/** Escritas que não merecem registro (ruído sem valor de auditoria). */
const SKIP = [/^\/api\/client-errors$/, /^\/api\/import$/, /^\/api\/extract$/, /^\/api\/notifications/, /^\/api\/audit/, /^\/api\/auth\/(forgot|reset)$/, /\/preview$/];

const BODY_KEYS = ["status", "role", "mode", "month", "audience", "reason", "type"] as const;
const NAME_KEYS = ["name", "title", "description", "identifier", "email", "number"] as const;

const normalize = (p: string) =>
  p
    .replace(/\/by-token\/[^/]+/, "/by-token/:token")
    .replace(/\/\d+(?=\/|$)/g, "/:id")
    .replace(/\/+$/, "");

function find(obj: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (!obj || typeof obj !== "object" || depth > 2) return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) if (typeof rec[k] === "string" && rec[k]) return rec[k] as string;
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = find(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function findId(obj: unknown): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.id === "number") return rec.id;
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { id?: unknown }).id === "number") {
      return (v as { id: number }).id;
    }
  }
  return undefined;
}

/** Descreve a requisição: usa a tabela de regras e cai num texto genérico (CRUD) para o resto. */
function describe(method: string, path: string): { kind: AuditKind; summary: string; entity: string; event?: string; generic: boolean } | null {
  const norm = normalize(path);
  const segs = path.split("/").filter(Boolean); // api, recurso, ...
  const resource = segs[1] === "portal" ? "portal" : (segs[1] ?? "");
  const rule = rules.find((r) => r.method === method && r.path.test(norm));
  if (rule) return rule.summary ? { kind: rule.kind, summary: rule.summary, entity: resource, event: rule.event, generic: false } : null;
  const noun = ENTITY[resource] ?? resource;
  if (method === "POST") return { kind: "create", summary: `Cadastrou ${noun}`, entity: resource, generic: true };
  if (method === "PUT" || method === "PATCH") return { kind: "update", summary: `Alterou ${noun}`, entity: resource, generic: true };
  if (method === "DELETE") return { kind: "delete", summary: `Excluiu ${noun}`, entity: resource, generic: true };
  return null;
}

/** Middleware: registra, ao fim da resposta, toda escrita bem-sucedida e toda negação de permissão (403). */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const path = req.originalUrl.split("?")[0]!;
  if (!path.startsWith("/api/") || SKIP.some((r) => r.test(path))) return next();

  // Guarda o corpo da resposta para extrair o id e um nome legível do que foi criado/alterado.
  let payload: unknown;
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    payload = body;
    return original(body);
  }) as typeof res.json;

  res.on("finish", () => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    const denied = res.statusCode === 403 && !!req.auth;
    if (!ok && !denied) return;
    const info = describe(req.method, path);
    if (!info) return;

    // Login, cadastro e aceite de convite ainda não têm sessão na requisição: o autor vem da resposta.
    const body = payload as { user?: { id: number; name: string; email: string }; organization?: { id: number }; role?: string };
    const actor = req.auth
      ? { organizationId: req.auth.organization.id, userId: req.auth.user.id, userName: req.auth.user.name, userEmail: req.auth.user.email, role: req.auth.role }
      : ok && body?.user && body.organization
        ? { organizationId: body.organization.id, userId: body.user.id, userName: body.user.name, userEmail: body.user.email, role: body.role }
        : null;
    if (!actor) return;

    const segs = path.split("/").filter(Boolean);
    const idInPath = segs.slice(2).find((s) => /^\d+$/.test(s));
    const entityId = idInPath ? Number(idInPath) : findId(payload);
    const label = ok && info.kind !== "auth" ? find(payload, NAME_KEYS) : undefined;
    const reqBody = (req.body ?? {}) as Record<string, unknown>;
    const metadata: Record<string, unknown> = { method: req.method, path: normalize(path) };
    for (const k of BODY_KEYS) if (typeof reqBody[k] === "string" || typeof reqBody[k] === "number") metadata[k] = reqBody[k];
    if (label) metadata.label = label;

    // Webhooks de saída: só escritas bem-sucedidas de módulos de negócio (ver webhooks.ts).
    if (ok) {
      const event = info.generic ? eventFor(info.entity, info.kind) : (info.event ?? null);
      if (event) {
        emitWebhook({
          organizationId: actor.organizationId,
          event,
          actor: { id: actor.userId, name: actor.userName, role: actor.role ?? null },
          entity: info.entity,
          entityId: entityId ?? null,
          summary: `${info.summary}${label ? ` — ${label}` : ""}`,
          data: payload,
        });
      }
    }

    background(
      recordAudit({
      ...actor,
      kind: denied ? "denied" : info.kind,
      entity: info.entity,
      entityId: entityId ?? null,
      summary: denied ? `Acesso negado: ${info.summary.toLowerCase()}` : `${info.summary}${label ? ` — ${label}` : ""}`,
      status: res.statusCode,
      metadata,
      ...requestInfo(req),
    }),
    );
  });
  next();
}

// ---------------------------------------------------------------------------------------------
// Consulta (somente administrador logado; chave de API nunca chega aqui).
// ---------------------------------------------------------------------------------------------

export const auditRouter = Router();
auditRouter.use("/audit", requireAuth, requireRole("admin"));

const KINDS = ["create", "update", "delete", "action", "auth", "denied", "system"];

interface Filters {
  where: string;
  params: unknown[];
}

function filtersFrom(req: Request): Filters | { error: string } {
  const q = req.query;
  const params: unknown[] = [req.auth!.organization.id];
  const where = ["organization_id = $1"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (str(q.q)) {
    params.push(`%${str(q.q).replace(/[\\%_]/g, "\\$&")}%`);
    const n = `$${params.length}`;
    where.push(`(summary ILIKE ${n} OR user_name ILIKE ${n} OR user_email ILIKE ${n} OR ip ILIKE ${n})`);
  }
  if (str(q.kind)) {
    if (!KINDS.includes(str(q.kind))) return { error: "Tipo inválido" };
    add("kind = ?", str(q.kind));
  }
  if (str(q.entity)) add("entity = ?", str(q.entity));
  if (str(q.user_id)) {
    if (!/^\d+$/.test(str(q.user_id))) return { error: "Usuário inválido" };
    add("user_id = ?", Number(str(q.user_id)));
  }
  for (const [key, op] of [["from", ">="], ["to", "<"]] as const) {
    const v = str(q[key]);
    if (!v) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return { error: "Data inválida (use AAAA-MM-DD)" };
    // Dia inteiro no fuso de Brasília; "até" é inclusivo (limite = dia seguinte).
    add(
      key === "from"
        ? `created_at ${op} (?::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'`
        : `created_at ${op} ((?::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'`,
      v,
    );
  }
  return { where: where.join(" AND "), params };
}

const COLUMNS = `id, user_id, user_name, user_email, role, kind, entity, entity_id, summary, status, metadata, ip, user_agent, created_at`;

auditRouter.get("/audit", async (req, res) => {
  const f = filtersFrom(req);
  if ("error" in f) {
    res.status(400).json({ error: f.error });
    return;
  }
  const { where, params } = f;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = /^\d+$/.test(String(req.query.before ?? "")) ? String(req.query.before) : null;
  const p = [...params];
  let sql = `SELECT ${COLUMNS} FROM audit_logs WHERE ${where}`;
  if (before) {
    p.push(before);
    sql += ` AND id < $${p.length}`;
  }
  p.push(limit + 1);
  sql += ` ORDER BY id DESC LIMIT $${p.length}`;
  const rows = await db.query<{ id: string | number }>(sql, p);
  const items = rows.slice(0, limit).map((r) => ({ ...r, id: Number(r.id) }));
  res.json({ items, next_before: rows.length > limit ? items[items.length - 1]!.id : null });
});

/** Quem aparece no registro (para o filtro por pessoa). */
auditRouter.get("/audit/actors", async (req, res) => {
  const items = await db.query(
    `SELECT user_id, max(user_name) AS user_name, max(user_email) AS user_email
       FROM audit_logs WHERE organization_id = $1 AND user_id IS NOT NULL
      GROUP BY user_id ORDER BY max(user_name)`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  // Evita injeção de fórmula ao abrir no Excel/Planilhas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
};

auditRouter.get("/audit/export", async (req, res) => {
  const f = filtersFrom(req);
  if ("error" in f) {
    res.status(400).json({ error: f.error });
    return;
  }
  const rows = await db.query<Record<string, unknown>>(
    `SELECT ${COLUMNS} FROM audit_logs WHERE ${f.where} ORDER BY id DESC LIMIT 5000`,
    f.params,
  );
  const head = ["Data/hora (UTC)", "Pessoa", "E-mail", "Papel", "Tipo", "Recurso", "Id", "O que aconteceu", "Status", "IP"];
  const lines = rows.map((r) =>
    [r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, r.user_name, r.user_email, r.role, r.kind, r.entity, r.entity_id, r.summary, r.status, r.ip]
      .map(csvCell)
      .join(","),
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="auditoria-ethos.csv"');
  res.send("﻿" + [head.map(csvCell).join(","), ...lines].join("\r\n"));
});
