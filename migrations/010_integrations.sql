-- Integrações: credenciais de serviços externos (Asaas, IA) e webhooks de saída (n8n, Make, Zapier…).
-- Segredos ficam CIFRADOS (AES-256-GCM, chave INTEGRATIONS_SECRET do servidor) e nunca voltam para o navegador:
-- a API devolve só os 4 últimos caracteres ("hint").

CREATE TABLE integrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('asaas','anthropic')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',        -- parte não secreta (ambiente, modelo…)
  secret_enc text,                           -- chave de API cifrada
  secret_hint text,                          -- últimos 4 caracteres, para reconhecer qual chave é
  last_tested_at timestamptz,
  last_status text CHECK (last_status IN ('ok','error')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

CREATE TABLE webhook_endpoints (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  secret_enc text NOT NULL,                  -- segredo de assinatura (HMAC), cifrado
  events text[] NOT NULL DEFAULT '{}',       -- {"*"} = todos
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_org ON webhook_endpoints (organization_id);

CREATE TABLE webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id integer NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','error')),
  http_status integer,
  error text,
  attempts integer NOT NULL DEFAULT 1,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, id DESC);

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
