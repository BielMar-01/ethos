-- Canais de aviso (e-mail, WhatsApp, push), novas categorias e segurança de conta (passkeys, aparelhos conhecidos,
-- bloqueio por país, expiração por inatividade).

-- Categorias novas (usadas pelos módulos seguintes).
ALTER TABLE notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('financeiro','manutencao','vistoria','contrato','comunicado','acesso','seguranca','encomenda','ocorrencia'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check
  CHECK (category IN ('financeiro','manutencao','vistoria','contrato','comunicado','acesso','seguranca','encomenda','ocorrencia'));

-- Preferência por canal. WhatsApp só com consentimento explícito (users.whatsapp_opt_in).
ALTER TABLE notification_preferences ADD COLUMN email boolean NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN whatsapp boolean NOT NULL DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN push boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN whatsapp_opt_in_at timestamptz;

-- Registro de envios externos (e dedupe de lembretes que não geram linha no sino).
CREATE TABLE deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer REFERENCES organizations(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','push')),
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  error text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deliveries_dedupe ON deliveries (user_id, channel, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'sent';
CREATE INDEX deliveries_recent ON deliveries (organization_id, id DESC);

CREATE TABLE push_subscriptions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Passkeys (WebAuthn).
CREATE TABLE webauthn_credentials (
  id text PRIMARY KEY,                 -- credentialID (base64url)
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials (user_id);

CREATE TABLE webauthn_challenges (
  id text PRIMARY KEY,                 -- SHA-256 do token entregue ao navegador
  kind text NOT NULL CHECK (kind IN ('register','login')),
  user_id integer REFERENCES users(id) ON DELETE CASCADE,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Aparelhos já vistos no login (impressão = hash de navegador+sistema); o primeiro uso de um novo gera alerta.
CREATE TABLE known_devices (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, fingerprint)
);

-- Bloqueio por país (cabeçalho do proxy, ex. x-vercel-ip-country) e expiração por inatividade.
ALTER TABLE users ADD COLUMN allowed_countries text;
ALTER TABLE organizations ADD COLUMN session_idle_minutes integer CHECK (session_idle_minutes IS NULL OR session_idle_minutes BETWEEN 15 AND 1440);

ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE known_devices ENABLE ROW LEVEL SECURITY;
