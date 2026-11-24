-- Operação 2: prestadores, manutenção preventiva recorrente, enquetes e ocorrências com multa.

CREATE TABLE providers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  document text,
  phone text,
  email text,
  categories text NOT NULL DEFAULT '',          -- categorias de manutenção que atende, separadas por vírgula
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX providers_org ON providers (organization_id, active);

ALTER TABLE maintenance_quotes ADD COLUMN provider_id integer REFERENCES providers(id) ON DELETE SET NULL;

CREATE TABLE provider_reviews (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id integer NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  request_id integer REFERENCES maintenance_requests(id) ON DELETE SET NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_reviews_once ON provider_reviews (provider_id, request_id) WHERE request_id IS NOT NULL;

-- Planos de manutenção preventiva: abrem um chamado sozinhos a cada N meses.
CREATE TABLE maintenance_plans (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('hidraulica','eletrica','estrutural','pintura','fechaduras','eletrodomesticos','pragas','outro')),
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa','media','alta','urgente')),
  interval_months integer NOT NULL CHECK (interval_months BETWEEN 1 AND 60),
  next_due date NOT NULL,
  lead_days integer NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 0 AND 60),
  active boolean NOT NULL DEFAULT true,
  assigned_to integer REFERENCES users(id) ON DELETE SET NULL,
  last_generated_for date,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maintenance_plans_due ON maintenance_plans (organization_id, active, next_due);
ALTER TABLE maintenance_requests ADD COLUMN plan_id integer REFERENCES maintenance_plans(id) ON DELETE SET NULL;

-- Enquetes (o mural de avisos já existe em Comunicados).
CREATE TABLE polls (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  question text NOT NULL,
  description text,
  audience text NOT NULL CHECK (audience IN ('todos','inquilinos','proprietarios')),
  property_id integer REFERENCES properties(id) ON DELETE CASCADE,
  anonymous boolean NOT NULL DEFAULT false,
  closes_at timestamptz,
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','encerrada')),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE poll_options (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id integer NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label text NOT NULL,
  position integer NOT NULL
);
CREATE TABLE poll_votes (
  poll_id integer NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id integer NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)
);

-- Ocorrências (barulho, dano, animais…) com notificação, contestação e multa opcional.
CREATE TABLE incidents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  lease_id integer REFERENCES leases(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('barulho','animais','dano','lixo','estacionamento','outro')),
  description text NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'registrada' CHECK (status IN ('registrada','notificada','multada','arquivada')),
  fine_cents integer CHECK (fine_cents IS NULL OR fine_cents > 0),
  fine_charge_id integer REFERENCES charges(id) ON DELETE SET NULL,
  contestation text,
  contested_at timestamptz,
  resolution_note text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_org ON incidents (organization_id, status, occurred_at);

ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
