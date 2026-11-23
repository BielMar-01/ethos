import crypto from "node:crypto";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { db } from "./db.js";
import { SESSION_COOKIE } from "./auth.js";

/** Hoje (AAAA-MM-DD) no fuso de Brasília. */
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

/** "2026-11" + n meses. */
function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface DemoSummary {
  owners: number;
  properties: number;
  units: number;
  tenants: number;
  leases: number;
  charges: number;
  payments: number;
  transfers: number;
  maintenance: number;
  inspections: number;
  invites: { label: string; link: string }[];
}

/** PNG de demonstração (degradê) gerado na hora: não há arquivos de imagem no repositório. */
function demoPng(variant: number, w = 240, h = 160): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const t = x / w;
      const s = y / h;
      row[1 + x * 3] = Math.round(70 + 120 * (variant === 0 ? t : s));
      row[2 + x * 3] = Math.round(90 + 90 * (variant === 0 ? s : t));
      row[3 + x * 3] = Math.round(110 + 60 * (1 - t));
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TEMPLATE = `[MODELO DE EXEMPLO — sem validade jurídica; substitua pelo texto aprovado]

CONTRATO DE LOCAÇÃO RESIDENCIAL

LOCADOR: {{locador.nome}}, documento {{locador.documento}}.
LOCATÁRIO: {{locatario.nome}}, documento {{locatario.cpf}}.
IMÓVEL: {{imovel.endereco}}, unidade {{unidade.identificacao}}.
PRAZO: de {{contrato.data_inicio}} a {{contrato.data_fim}}.
ALUGUEL: {{contrato.valor_aluguel}}, com vencimento todo dia {{contrato.dia_vencimento}}.
GARANTIA: {{contrato.garantia}}.`;

/**
 * Popula uma organização VAZIA com dados fictícios, usando a própria API (assim recibos, baixas e
 * repasses nascem consistentes). Recusa se a organização já tiver imóveis.
 */
export async function seedDemo(organizationId: number, userId: number): Promise<DemoSummary> {
  const [existing] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM properties WHERE organization_id = $1", [organizationId]);
  if (existing!.n > 0) throw new Error("A organização já tem imóveis; os dados de demonstração só entram em organização vazia.");

  // Sessão temporária de 1 hora, só para este processo.
  const sid = crypto.randomBytes(32).toString("hex");
  await db.query("INSERT INTO sessions (id, user_id, organization_id, expires_at) VALUES ($1, $2, $3, $4)", [
    sid, userId, organizationId, new Date(Date.now() + 3600_000),
  ]);
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Cookie: `${SESSION_COOKIE}=${sid}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json?.error ?? text}`);
    return json;
  };

  const uploadPhoto = async (path: string, png: Buffer) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "image/png", Cookie: `${SESSION_COOKIE}=${sid}` },
      body: new Uint8Array(png),
    });
    if (!res.ok) throw new Error(`foto ${path} → ${res.status}`);
  };

  try {
    const owner = async (name: string, document: string) =>
      (await call("POST", "/api/owners", { name, document, email: `${document.slice(0, 3)}@example.com` })).item.id as number;
    const maria = await owner("Maria Souza (demo)", "000.000.001-91");
    const joao = await owner("João Pereira (demo)", "000.000.002-72");

    const property = async (name: string, type: string, number: string, ownerIds: number[]) => {
      const p = (await call("POST", "/api/properties", {
        name, type, street: "Rua das Flores (demo)", number, neighborhood: "Centro", city: "São Paulo", state: "SP", zip: "01000-000",
      })).item.id as number;
      await call("PUT", `/api/properties/${p}/owners`, { ownerIds });
      return p;
    };
    const aurora = await property("Edifício Aurora (demo)", "apartamento", "100", [maria]);
    const palmeiras = await property("Vila das Palmeiras (demo)", "terreno", "250", [maria, joao]);

    const unit = async (propertyId: number, identifier: string, bedrooms: number, area: number) =>
      (await call("POST", "/api/units", { property_id: propertyId, identifier, bedrooms, area_m2: area })).item.id as number;
    const units = [
      await unit(aurora, "Apto 101", 2, 62),
      await unit(aurora, "Apto 102", 1, 45),
      await unit(aurora, "Apto 201", 3, 88), // fica disponível
      await unit(palmeiras, "Casa 1", 2, 70),
      await unit(palmeiras, "Casa 2", 2, 70),
    ];

    const tenant = async (name: string, document: string) =>
      (await call("POST", "/api/tenants", { name, document, email: `${document.slice(0, 3)}t@example.com`, phone: "(11) 90000-0000" })).item.id as number;
    const tenants = [
      await tenant("Carlos Almeida (demo)", "000.000.011-01"),
      await tenant("Beatriz Lima (demo)", "000.000.012-82"),
      await tenant("Rafael Costa (demo)", "000.000.013-63"),
      await tenant("Juliana Martins (demo)", "000.000.014-44"),
    ];

    const template = (await call("POST", "/api/contract-templates", { name: "Locação residencial (exemplo)", body: TEMPLATE })).item.id as number;

    const current = today().slice(0, 7);
    const startMonth = addMonths(current, -3);
    const endMonth = addMonths(current, 21);
    const rents = [250000, 180000, 320000, 150000];
    const dueDays = [5, 10, 15, 5];
    const leases: number[] = [];
    for (let i = 0; i < 4; i++) {
      const lease = (await call("POST", "/api/leases", {
        unit_id: [units[0], units[1], units[3], units[4]][i],
        tenantIds: [tenants[i]],
        start_date: `${startMonth}-01`,
        end_date: `${endMonth}-28`,
        rent_cents: rents[i],
        due_day: dueDays[i],
        guarantee: i % 2 === 0 ? "Caução de três aluguéis" : "Seguro fiança",
      })).lease.id as number;
      await call("POST", `/api/leases/${lease}/status`, { status: "vigente" });
      leases.push(lease);
    }
    await call("POST", `/api/leases/${leases[0]}/documents`, { templateId: template });
    await call("PUT", "/api/settings/finance", { admin_fee_bps: 1000 });

    // Cobranças dos últimos 3 meses; pagamentos: tudo pago, exceto o contrato 3 (atrasado/parcial).
    const months = [addMonths(current, -2), addMonths(current, -1), current];
    let charges = 0;
    let payments = 0;
    const now = today();
    for (const month of months) {
      const gen = await call("POST", "/api/charges/generate", { month });
      charges += gen.created;
      const items = (await call("GET", `/api/charges?month=${month}`)).items as {
        id: number; lease_id: number; due_date: string; amount_cents: number;
      }[];
      for (const c of items) {
        const idx = leases.indexOf(c.lease_id);
        if (c.due_date > now) continue; // ainda não venceu: fica em aberto
        const overdueCase = idx === 2 && month !== months[0];
        if (overdueCase && month === months[2]) continue; // mês atual do contrato 3: não pagou
        const amount = overdueCase ? Math.floor(c.amount_cents / 2) : c.amount_cents; // pagou metade do mês anterior
        await call("POST", "/api/payments", {
          lease_id: c.lease_id,
          received_at: c.due_date,
          amount_cents: amount,
          method: ["pix", "boleto", "transferencia"][idx % 3],
          allocations: [{ charge_id: c.id, amount_cents: amount }],
        });
        payments += 1;
      }
    }

    // Repasses dos meses fechados; o mais antigo já pago.
    let transfers = 0;
    for (const month of months.slice(0, 2)) {
      transfers += (await call("POST", "/api/transfers/generate", { period: month })).generated;
    }
    for (const t of (await call("GET", `/api/transfers?period=${months[0]}`)).items as { id: number }[]) {
      await call("POST", `/api/transfers/${t.id}/pay`, {});
    }

    // Manutenção: um chamado em execução (com fotos e orçamentos), um concluído e um recém-aberto.
    const maint = async (unitId: number, title: string, category: string, priority: string, description: string) =>
      (await call("POST", "/api/maintenance", { unit_id: unitId, title, category, priority, description })).id as number;
    const setStatus = (id: number, status: string, extra: Record<string, unknown> = {}) => call("POST", `/api/maintenance/${id}/status`, { status, ...extra });

    const leak = await maint(units[0]!, "Vazamento na pia da cozinha", "hidraulica", "alta", "A torneira pinga o tempo todo e o armário abaixo está úmido.");
    await uploadPhoto(`/api/maintenance/${leak}/photos`, demoPng(0));
    await setStatus(leak, "em_analise");
    await call("POST", `/api/maintenance/${leak}/quotes`, { supplier: "Hidro Ltda (demo)", amount_cents: 45000 });
    const cheaper = (await call("POST", `/api/maintenance/${leak}/quotes`, { supplier: "Encanador Zé (demo)", amount_cents: 38000, notes: "Inclui material" })).id as number;
    await call("POST", `/api/maintenance/${leak}/quotes/${cheaper}/approve`);
    await setStatus(leak, "em_execucao");
    await call("POST", `/api/maintenance/${leak}/comments`, { message: "Encanador agendado para terça, 9h.", client_visible: true });

    const bulb = await maint(units[1]!, "Troca de lâmpada do corredor", "eletrica", "baixa", "Lâmpada queimada no corredor de entrada.");
    await setStatus(bulb, "em_analise");
    await setStatus(bulb, "em_execucao");
    await setStatus(bulb, "concluida", { cost_cents: 4500 });
    await maint(units[3]!, "Infiltração no teto do quarto", "estrutural", "urgente", "Mancha escura crescendo perto da janela; pingou na última chuva.");

    // Vistorias: uma de entrada concluída e assinada (com foto) e uma periódica agendada.
    const entry = (await call("POST", "/api/inspections", { unit_id: units[0], type: "entrada", scheduled_for: `${startMonth}-01`, notes: "Imóvel entregue recém-pintado." })).id as number;
    await call("POST", `/api/inspections/${entry}/status`, { status: "em_andamento" });
    const entryItems = (await call("GET", `/api/inspections/${entry}`)).items as { id: number; room: string; item: string }[];
    for (const [i, it] of entryItems.entries()) {
      const worn = it.item === "Piso" && it.room === "Cozinha";
      await call("PATCH", `/api/inspections/${entry}/items/${it.id}`, {
        condition: worn ? "regular" : i % 7 === 0 ? "novo" : "bom",
        notes: worn ? "Risco leve perto da pia." : null,
      });
    }
    await uploadPhoto(`/api/inspections/${entry}/items/${entryItems.find((i) => i.room === "Cozinha" && i.item === "Piso")!.id}/photos`, demoPng(1));
    await call("POST", `/api/inspections/${entry}/status`, { status: "concluida", performed_at: `${startMonth}-01` });
    await call("POST", `/api/inspections/${entry}/signatures`, { role: "vistoriador", signer_name: "Ana Administradora" });
    await call("POST", `/api/inspections/${entry}/signatures`, { role: "locatario", signer_name: "Carlos Almeida" });
    await call("POST", "/api/inspections", { unit_id: units[1], type: "periodica", scheduled_for: `${addMonths(current, 1)}-10` });

    // Convites para experimentar a área do cliente.
    const invites: DemoSummary["invites"] = [];
    const tenantInvite = await call("POST", "/api/invitations", { email: "demo.inquilino@example.com", role: "inquilino", tenantId: tenants[0] });
    invites.push({ label: "Inquilino (Carlos Almeida)", link: tenantInvite.link });
    const ownerInvite = await call("POST", "/api/invitations", { email: "demo.proprietario@example.com", role: "proprietario", ownerId: maria });
    invites.push({ label: "Proprietário (Maria Souza)", link: ownerInvite.link });

    return {
      owners: 2, properties: 2, units: units.length, tenants: tenants.length, leases: leases.length, charges, payments, transfers,
      maintenance: 3, inspections: 2, invites,
    };
  } finally {
    server.close();
    await db.query("DELETE FROM sessions WHERE id = $1", [sid]);
  }
}
