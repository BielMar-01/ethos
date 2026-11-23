-- Módulo de contratos: modelos, contratos de locação, partes e documentos gerados.

CREATE TABLE contract_templates (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL,
  -- Sobe a cada alteração do texto; o documento gerado guarda a versão usada.
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE leases (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT: não se apaga unidade (nem imóvel) que tenha contrato.
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date NOT NULL,
  rent_cents integer NOT NULL CHECK (rent_cents > 0),
  due_day integer NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  guarantee text,
  notes text,
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','vigente','encerrado','rescindido')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

-- Locatários do contrato (mais de um por contrato); position 0 = principal.
CREATE TABLE lease_tenants (
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  PRIMARY KEY (lease_id, tenant_id)
);

-- Documento emitido: imutável (não há UPDATE na API). Guarda o texto final e os dados
-- do momento, de modo que mudanças posteriores no cadastro não alteram contratos emitidos.
CREATE TABLE contract_documents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  template_id integer REFERENCES contract_templates(id) ON DELETE SET NULL,
  template_name text NOT NULL,
  template_version integer NOT NULL,
  content text NOT NULL,
  variables jsonb NOT NULL,
  generated_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON contract_templates (organization_id);
CREATE INDEX ON leases (organization_id);
CREATE INDEX ON leases (unit_id, status);
CREATE INDEX ON lease_tenants (tenant_id);
CREATE INDEX ON contract_documents (lease_id);
CREATE INDEX ON contract_documents (organization_id);

ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
