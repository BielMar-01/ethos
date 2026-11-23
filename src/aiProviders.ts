/**
 * Provedores de IA aceitos para ler documentos. Anthropic usa o SDK oficial (extract.ts); todos os outros falam o
 * protocolo "chat completions" da OpenAI, que a maioria dos serviços adotou — por isso basta mudar a URL base.
 * A lista de modelos é só SUGESTÃO (os nomes mudam rápido): o administrador pode digitar qualquer ID de modelo.
 */

export interface AiProviderDef {
  id: string;
  label: string;
  kind: "anthropic" | "openai";
  /** URL base fixa (null = o administrador informa, ex.: "outro provedor compatível"). */
  baseUrl: string | null;
  models: string[];
  /** Lê imagens? */
  vision: boolean;
  /** Aceita PDF direto? Se não, o servidor extrai o texto do PDF e envia como texto. */
  pdf: boolean;
  /** Aceita resposta com esquema JSON estrito? Se não, usa modo JSON simples com o esquema no prompt. */
  jsonSchema: boolean;
  /** Onde criar a chave. */
  keyUrl: string;
  note?: string;
}

export const AI_PROVIDERS: AiProviderDef[] = [
  { id: "anthropic", label: "Anthropic (Claude)", kind: "anthropic", baseUrl: null, models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], vision: true, pdf: true, jsonSchema: true, keyUrl: "console.anthropic.com" },
  { id: "openai", label: "OpenAI (GPT)", kind: "openai", baseUrl: "https://api.openai.com/v1", models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"], vision: true, pdf: true, jsonSchema: true, keyUrl: "platform.openai.com/api-keys" },
  { id: "google", label: "Google (Gemini)", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"], vision: true, pdf: false, jsonSchema: true, keyUrl: "aistudio.google.com/apikey" },
  { id: "xai", label: "xAI (Grok)", kind: "openai", baseUrl: "https://api.x.ai/v1", models: ["grok-4", "grok-2-vision-1212"], vision: true, pdf: false, jsonSchema: true, keyUrl: "console.x.ai" },
  { id: "deepseek", label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"], vision: false, pdf: false, jsonSchema: false, keyUrl: "platform.deepseek.com/api_keys", note: "Só lê texto: serve para PDFs com texto, não para fotos." },
  { id: "mistral", label: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", models: ["pixtral-large-latest", "mistral-small-latest"], vision: true, pdf: false, jsonSchema: true, keyUrl: "console.mistral.ai/api-keys" },
  { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", models: ["meta-llama/llama-4-scout-17b-16e-instruct"], vision: true, pdf: false, jsonSchema: false, keyUrl: "console.groq.com/keys" },
  { id: "together", label: "Together AI", kind: "openai", baseUrl: "https://api.together.xyz/v1", models: ["meta-llama/Llama-4-Scout-17B-16E-Instruct"], vision: true, pdf: false, jsonSchema: false, keyUrl: "api.together.ai/settings/api-keys" },
  { id: "openrouter", label: "OpenRouter (centenas de modelos)", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", models: ["openai/gpt-4o-mini", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5", "x-ai/grok-4"], vision: true, pdf: true, jsonSchema: true, keyUrl: "openrouter.ai/keys", note: "Uma chave dá acesso a modelos de vários fabricantes; o ID tem o formato fabricante/modelo." },
  { id: "custom", label: "Outro (compatível com a API da OpenAI)", kind: "openai", baseUrl: null, models: [], vision: true, pdf: false, jsonSchema: false, keyUrl: "", note: "Informe a URL base (https) do seu serviço, por exemplo Azure OpenAI, vLLM ou LiteLLM publicados na internet." },
];

export const AI_IDS = AI_PROVIDERS.map((p) => p.id);
export const aiProvider = (id: string) => AI_PROVIDERS.find((p) => p.id === id);
export const isAiProvider = (id: string) => AI_IDS.includes(id);

/** ID de modelo: letras, números e . _ - / : @ (cobre "openai/gpt-4o", "meta-llama/Llama-4…", "gpt-4o:latest"). */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,99}$/;
