-- Schema inicial do Ethos (PostgreSQL / Supabase).
-- O back-end é o único cliente do banco. RLS é ativado SEM políticas em todas as
-- tabelas: a publishable key (pública) usada via API REST do Supabase não lê nem
-- grava nada. A conexão do servidor (role postgres) ignora RLS por definição.

CREATE TABLE organizations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Um usuário pode ter vínculos e papéis diferentes em organizações diferentes.
CREATE TABLE organization_members (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','colaborador','proprietario','inquilino')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE owners (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  document text NOT NULL,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, document)
);

CREATE TABLE properties (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('casa','apartamento','terreno','comercial','outro')),
  street text, number text, complement text, neighborhood text,
  city text, state text, zip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Um imóvel pode ter mais de um proprietário.
CREATE TABLE property_owners (
  property_id integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  owner_id integer NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  PRIMARY KEY (property_id, owner_id)
);

-- Unidade locável: um imóvel pode ter várias (ex.: terreno com dez casas).
CREATE TABLE units (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  identifier text NOT NULL,
  area_m2 integer,
  bedrooms integer,
  rent_reference_cents integer,
  status text NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel','ocupada','manutencao')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, identifier)
);

CREATE TABLE tenants (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  document text NOT NULL,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, document)
);

CREATE INDEX ON organization_members (user_id);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);
CREATE INDEX ON properties (organization_id);
CREATE INDEX ON units (organization_id);
CREATE INDEX ON owners (organization_id);
CREATE INDEX ON tenants (organization_id);
CREATE INDEX ON property_owners (owner_id);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
