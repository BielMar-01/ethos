import { assertPublicUrl } from "./webhooks.js";
import type { AiProviderDef } from "./aiProviders.js";

export class ExtractError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export type Media = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

/** Texto de um PDF (para provedores que não leem PDF direto). Vazio = PDF escaneado, sem texto. */
async function pdfText(data: Buffer): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text).replace(/\s+\n/g, "\n").trim();
  } catch (err) {
    console.error("Falha ao extrair texto do PDF:", err instanceof Error ? err.message : err);
    throw new ExtractError("Não consegui ler este PDF. Tente enviar como foto ou use um provedor que leia PDF.", 422);
  }
}

/** Tira cercas de código e acha o objeto JSON numa resposta de texto. */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("sem JSON");
  }
}

export interface CompatInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  def: AiProviderDef;
  data: Buffer;
  media: Media;
  system: string;
  schema: Record<string, unknown>;
  /** URLs dos fabricantes são fixas e confiáveis; só a URL informada pelo administrador passa pela checagem de rede pública. */
  checkUrl: boolean;
}

type Part = Record<string, unknown>;

/** Uma chamada "chat completions" (OpenAI e compatíveis). Devolve o texto da resposta. */
export async function callOpenAiCompat(i: CompatInput): Promise<string> {
  if (i.checkUrl) {
    try {
      await assertPublicUrl(i.baseUrl);
    } catch (err) {
      throw new ExtractError(err instanceof Error ? err.message : "Endereço do provedor inválido.", 422);
    }
  }

  const b64 = i.data.toString("base64");
  const content: Part[] = [{ type: "text", text: "Extraia os dados deste documento." }];
  if (i.media === "application/pdf") {
    if (i.def.pdf) {
      content.push({ type: "file", file: { filename: "documento.pdf", file_data: `data:application/pdf;base64,${b64}` } });
    } else {
      const text = await pdfText(i.data);
      if (text.length < 30) throw new ExtractError("Este PDF parece escaneado (sem texto) e este provedor não lê imagens de PDF. Envie fotos das páginas ou use outro provedor.", 422);
      content[0] = { type: "text", text: `Extraia os dados do documento abaixo (texto extraído de um PDF).\n\n---\n${text.slice(0, 60_000)}\n---` };
    }
  } else {
    if (!i.def.vision) throw new ExtractError(`${i.def.label} só lê texto, não imagens. Envie um PDF com texto ou escolha outro provedor em Integrações.`, 422);
    content.push({ type: "image_url", image_url: { url: `data:${i.media};base64,${b64}` } });
  }

  const post = async (mode: "schema" | "object") => {
    const system = mode === "schema" ? i.system : `${i.system}\n\nResponda SOMENTE com um objeto JSON válido neste formato (sem texto fora do JSON):\n${JSON.stringify(i.schema)}`;
    const response_format =
      mode === "schema" ? { type: "json_schema", json_schema: { name: "dados_do_documento", strict: true, schema: i.schema } } : { type: "json_object" };
    return fetch(`${i.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${i.apiKey}`, "User-Agent": "Ethos" },
      body: JSON.stringify({ model: i.model, messages: [{ role: "system", content: system }, { role: "user", content }], response_format }),
    });
  };

  let res: Response;
  try {
    res = await post(i.def.jsonSchema ? "schema" : "object");
    // Alguns modelos/serviços não aceitam o esquema estrito: repete no modo JSON simples.
    if (res.status === 400 && i.def.jsonSchema) {
      const detail = await res.clone().text();
      if (/response_format|json_schema|schema|structured/i.test(detail)) res = await post("object");
    }
  } catch (err) {
    console.error(`${i.def.id}: falha de rede:`, err instanceof Error ? err.message : err);
    throw new ExtractError(`Não foi possível falar com ${i.def.label} agora. Tente novamente ou preencha manualmente.`, 502);
  }

  if (res.status === 401 || res.status === 403) throw new ExtractError(`${i.def.label} recusou a chave. Confira em Integrações.`, 503);
  if (res.status === 402) throw new ExtractError(`${i.def.label} informou falta de saldo/crédito na conta.`, 503);
  if (res.status === 429) throw new ExtractError("O serviço de leitura está sobrecarregado ou o limite da chave foi atingido. Tente novamente em instantes.", 429);
  if (res.status === 404) throw new ExtractError(`${i.def.label} não encontrou o modelo "${i.model}". Confira o nome em Integrações.`, 422);
  if (res.status >= 300) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`${i.def.id}: HTTP ${res.status}: ${detail}`);
    throw new ExtractError(res.status === 400 ? "Este modelo não aceitou o arquivo. Tente outro modelo (que leia imagens/PDF) ou outro arquivo." : "Não foi possível ler este arquivo agora. Tente novamente ou preencha manualmente.", res.status === 400 ? 422 : 502);
  }
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[] } | null;
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") throw new ExtractError("O documento é complexo demais para ler de uma vez. Envie uma página por vez.", 422);
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (!text) throw new ExtractError("O serviço não devolveu dados. Tente de novo ou preencha manualmente.", 502);
  return text;
}
