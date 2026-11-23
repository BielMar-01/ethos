-- Boletos emitidos pelo Asaas a partir de cobranças. O boleto NÃO substitui a cobrança nem o pagamento:
-- a cobrança continua sendo o que é devido; quando o boleto é pago, o recebimento é registrado em Financeiro.

-- Cliente do Asaas criado para cada inquilino (evita duplicar cadastro a cada boleto).
CREATE TABLE asaas_customers (
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, tenant_id, environment)
);

CREATE TABLE boletos (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  charge_id integer NOT NULL REFERENCES charges(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'asaas' CHECK (provider IN ('asaas')),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  external_id text NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','vencida','paga','cancelada')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  due_date date NOT NULL,
  invoice_url text,                 -- página do Asaas com o boleto (PDF/Pix)
  bank_slip_url text,               -- PDF do boleto
  identification_field text,        -- linha digitável
  bar_code text,
  paid_at date,                     -- quando o Asaas informou o recebimento
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, environment, external_id)
);

-- No máximo um boleto em aberto por cobrança.
CREATE UNIQUE INDEX boletos_one_open ON boletos (charge_id) WHERE status IN ('pendente','vencida');
CREATE INDEX boletos_org_status ON boletos (organization_id, status);

ALTER TABLE asaas_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE boletos ENABLE ROW LEVEL SECURITY;
