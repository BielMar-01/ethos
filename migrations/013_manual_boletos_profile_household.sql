-- Boletos manuais (sem integração), perfil do usuário, moradores e controle de acesso (visitantes).

-- 1) Boleto manual: registrado/gerado dentro do Ethos, sem falar com nenhum banco.
ALTER TABLE boletos DROP CONSTRAINT boletos_provider_check;
ALTER TABLE boletos ADD CONSTRAINT boletos_provider_check CHECK (provider IN ('asaas','manual'));
ALTER TABLE boletos DROP CONSTRAINT boletos_environment_check;
ALTER TABLE boletos ADD CONSTRAINT boletos_environment_check CHECK (environment IN ('sandbox','production','manual'));
ALTER TABLE boletos ADD COLUMN our_number text;   -- "nosso número" informado pela equipe
ALTER TABLE boletos ADD COLUMN notes text;

-- 2) Perfil do usuário (o e-mail já existe; a senha mora no provedor de identidade).
ALTER TABLE users ADD COLUMN phone text;
ALTER TABLE users ADD COLUMN document text;
ALTER TABLE users ADD COLUMN birth_date date;

-- 3) Notificações de portaria (chegada de visitante).
ALTER TABLE notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check CHECK (category IN ('financeiro','manutencao','vistoria','contrato','comunicado','acesso'));
ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_category_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_category_check CHECK (category IN ('financeiro','manutencao','vistoria','contrato','comunicado','acesso'));

-- 4) Moradores: quem mora na unidade além dos locatários do contrato (cônjuge, filhos, parentes, funcionários…).
CREATE TABLE residents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('conjuge','filho','pai_mae','irmao','parente','agregado','empregado','outro')),
  document text,
  birth_date date,
  phone text,
  email text,
  notes text,
  moved_in_at date,
  moved_out_at date,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (moved_out_at IS NULL OR moved_in_at IS NULL OR moved_out_at >= moved_in_at)
);
CREATE INDEX residents_lease ON residents (organization_id, lease_id);

-- 5) Visitantes autorizados (uma visita ou uma autorização recorrente com validade) e o registro de entradas/saídas.
CREATE TABLE visitors (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  lease_id integer REFERENCES leases(id) ON DELETE SET NULL,
  name text NOT NULL,
  document text,
  phone text,
  category text NOT NULL DEFAULT 'visitante' CHECK (category IN ('visitante','familiar','prestador','entregador','outro')),
  vehicle_plate text,
  valid_from date NOT NULL,
  valid_until date NOT NULL,
  access_code text NOT NULL,
  status text NOT NULL DEFAULT 'autorizado' CHECK (status IN ('autorizado','cancelado','bloqueado')),
  notes text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_by_role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until >= valid_from)
);
CREATE UNIQUE INDEX visitors_code ON visitors (organization_id, access_code);
CREATE INDEX visitors_unit ON visitors (organization_id, unit_id);

CREATE TABLE access_events (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  visitor_id integer NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('entrada','saida')),
  at timestamptz NOT NULL DEFAULT now(),
  recorded_by integer REFERENCES users(id) ON DELETE SET NULL,
  note text
);
CREATE INDEX access_events_visitor ON access_events (visitor_id, id);

ALTER TABLE residents ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_events ENABLE ROW LEVEL SECURITY;
