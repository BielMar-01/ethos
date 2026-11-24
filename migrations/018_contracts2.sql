-- Contratos 2: aditivos/renovação/reajuste, rescisão guiada, garantias, análise de crédito, interessados e visitas,
-- documentos por imóvel e assinatura eletrônica simples.

-- Aditivos (renovação, reajuste e outros). Guardam o antes e o depois e o texto emitido.
CREATE TABLE lease_addenda (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('renovacao','reajuste','aditivo')),
  effective_from date NOT NULL,
  previous_end date NOT NULL,
  new_end date,
  previous_rent_cents integer NOT NULL,
  new_rent_cents integer,
  index_name text,
  index_percent numeric(8,4),
  notes text,
  content text NOT NULL,
  applied_at timestamptz,                    -- null = agendado (entra em vigor em effective_from)
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lease_addenda_lease ON lease_addenda (lease_id);

-- Rescisão: o que foi apurado e decidido.
CREATE TABLE lease_terminations (
  lease_id integer PRIMARY KEY REFERENCES leases(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  terminated_on date NOT NULL,
  reason text,
  fine_months numeric(5,2) NOT NULL,
  fine_cents integer NOT NULL CHECK (fine_cents >= 0),
  fine_waived boolean NOT NULL DEFAULT false,
  fine_charge_id integer REFERENCES charges(id) ON DELETE SET NULL,
  cancelled_charges integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Garantias do contrato.
CREATE TABLE lease_guarantees (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fiador','caucao','seguro_fianca','titulo_capitalizacao','outro')),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','liberada','executada')),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  valid_until date,
  details jsonb NOT NULL DEFAULT '{}',
  notes text,
  expiry_alerted_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lease_guarantees_lease ON lease_guarantees (lease_id);

-- Interessados (funil) e agenda de visitas.
CREATE TABLE leads (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','site','indicacao','portal','outro')),
  unit_id integer REFERENCES units(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo','contato','visita_agendada','proposta','ganho','perdido')),
  message text,
  notes text,
  assigned_to integer REFERENCES users(id) ON DELETE SET NULL,
  consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_org_status ON leads (organization_id, status);

CREATE TABLE lead_visits (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id integer NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  unit_id integer REFERENCES units(id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'agendada' CHECK (status IN ('agendada','realizada','cancelada','faltou')),
  assigned_to integer REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_visits_when ON lead_visits (organization_id, scheduled_at);

-- Vitrine pública de unidades disponíveis e formulário de interesse (liga/desliga pelo admin; o token vai no link).
ALTER TABLE organizations ADD COLUMN public_token text UNIQUE;

-- Análise de crédito do candidato (manual; exige consentimento).
CREATE TABLE credit_checks (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id integer REFERENCES leads(id) ON DELETE SET NULL,
  name text NOT NULL,
  document text NOT NULL,
  income_cents integer NOT NULL CHECK (income_cents >= 0),
  rent_cents integer NOT NULL CHECK (rent_cents > 0),
  negative_records boolean NOT NULL DEFAULT false,
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 1000),
  ratio numeric(6,2) NOT NULL,
  recommendation text NOT NULL CHECK (recommendation IN ('aprovar','revisar','reprovar')),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','reprovado')),
  notes text,
  consent_at timestamptz NOT NULL,
  decided_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Documentos do imóvel (matrícula, IPTU, seguro…) com vencimento e alerta.
CREATE TABLE property_documents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('matricula','iptu','seguro','habitese','laudo','contrato','outro')),
  title text NOT NULL,
  expires_at date,
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  data bytea NOT NULL,
  alert_stage integer NOT NULL DEFAULT 0,      -- 0 nenhum, 1 avisou aos 30 dias, 2 avisou vencido
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX property_documents_prop ON property_documents (property_id);
CREATE INDEX property_documents_exp ON property_documents (organization_id, expires_at);

-- Assinatura eletrônica SIMPLES de documentos de contrato (link + nome digitado + evidências; não é ICP-Brasil).
CREATE TABLE signature_requests (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id integer NOT NULL REFERENCES contract_documents(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','concluida','cancelada')),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX signature_one_open ON signature_requests (document_id) WHERE status = 'pendente';
CREATE TABLE signers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id integer NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  role text NOT NULL CHECK (role IN ('locador','locatario','fiador','testemunha','outro')),
  token_hash text NOT NULL UNIQUE,
  viewed_at timestamptz,
  signed_at timestamptz,
  signed_name text,
  signed_ip text,
  signed_user_agent text
);
CREATE INDEX signers_request ON signers (request_id);

ALTER TABLE lease_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_terminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_guarantees ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signers ENABLE ROW LEVEL SECURITY;
