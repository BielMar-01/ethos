-- Vários provedores de IA por organização (Anthropic, OpenAI, Google Gemini, xAI Grok, DeepSeek, Mistral, Groq,
-- OpenRouter, Together e qualquer endpoint compatível com a API da OpenAI). A lista permitida fica no aplicativo
-- (src/aiProviders.ts), então aqui só garantimos que o texto do provedor é um identificador simples.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$');
