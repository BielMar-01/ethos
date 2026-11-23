-- Manutenção, vistorias e fotos (docs/CONTEXTO-ETHOS.md §8.7 e §8.8).

-- ------------------------------------------------------------------ Manutenção
CREATE TABLE maintenance_requests (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  lease_id integer REFERENCES leases(id) ON DELETE SET NULL,
  opened_by_tenant_id integer REFERENCES tenants(id) ON DELETE SET NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('hidraulica','eletrica','estrutural','pintura','fechaduras','eletrodomesticos','pragas','outro')),
  title text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'media' CHECK (priority IN ('baixa','media','alta','urgente')),
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN
    ('aberta','em_analise','aguardando_aprovacao','aprovada','em_execucao','concluida','cancelada')),
  assigned_to integer REFERENCES users(id) ON DELETE SET NULL,   -- responsável (equipe)
  cost_cents integer CHECK (cost_cents >= 0),                    -- custo final, informado na conclusão
  cancelled_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_quotes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id integer NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  supplier text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  notes text,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','recusado')),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  decided_by integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Linha do tempo. author_name é um retrato do nome na época (o usuário pode sair depois).
CREATE TABLE maintenance_updates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id integer NOT NULL REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  author_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('status','comentario','orcamento')),
  message text NOT NULL,
  client_visible boolean NOT NULL DEFAULT true,   -- false = nota interna da equipe
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- Vistorias
CREATE TABLE inspections (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  lease_id integer REFERENCES leases(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('entrada','saida','periodica')),
  status text NOT NULL DEFAULT 'agendada' CHECK (status IN ('agendada','em_andamento','concluida','cancelada')),
  scheduled_for date NOT NULL,
  performed_at date,
  inspector_id integer REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE inspection_items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inspection_id integer NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  room text NOT NULL,
  item text NOT NULL,
  condition text CHECK (condition IN ('novo','bom','regular','ruim','danificado')),  -- NULL = ainda não avaliado
  notes text,
  position integer NOT NULL,
  UNIQUE (inspection_id, room, item)
);

-- Registro de ciência/assinatura. É um REGISTRO (nome digitado + data), não assinatura eletrônica qualificada.
CREATE TABLE inspection_signatures (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inspection_id integer NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('vistoriador','locatario','proprietario')),
  signer_name text NOT NULL,
  signed_by integer REFERENCES users(id) ON DELETE SET NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, role)
);

-- ---------------------------------------------------------------------- Fotos
-- Guardadas no banco (privadas: só saem por rota autenticada). Uma foto pertence a um chamado OU a um item de vistoria.
CREATE TABLE photos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  maintenance_request_id integer REFERENCES maintenance_requests(id) ON DELETE CASCADE,
  inspection_item_id integer REFERENCES inspection_items(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  data bytea NOT NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((maintenance_request_id IS NULL) <> (inspection_item_id IS NULL))
);

CREATE INDEX ON maintenance_requests (organization_id, status);
CREATE INDEX ON maintenance_requests (unit_id);
CREATE INDEX ON maintenance_requests (lease_id);
CREATE INDEX ON maintenance_quotes (request_id);
CREATE INDEX ON maintenance_updates (request_id);
CREATE INDEX ON inspections (organization_id, status);
CREATE INDEX ON inspections (unit_id);
CREATE INDEX ON inspection_items (inspection_id);
CREATE INDEX ON inspection_signatures (inspection_id);
CREATE INDEX ON photos (maintenance_request_id);
CREATE INDEX ON photos (inspection_item_id);

ALTER TABLE maintenance_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
