-- Financeiro 2: multa/juros automáticos, pro rata, conciliação bancária, rateio, desconto de manutenção no repasse
-- e baixa do boleto pago.

-- Configuração por organização.
ALTER TABLE organizations ADD COLUMN late_fee_bps integer NOT NULL DEFAULT 0 CHECK (late_fee_bps BETWEEN 0 AND 1000);       -- multa única (200 = 2%)
ALTER TABLE organizations ADD COLUMN late_interest_bps integer NOT NULL DEFAULT 0 CHECK (late_interest_bps BETWEEN 0 AND 1000); -- juros a cada 30 dias de atraso (100 = 1%)
ALTER TABLE organizations ADD COLUMN late_grace_days integer NOT NULL DEFAULT 0 CHECK (late_grace_days BETWEEN 0 AND 30);
ALTER TABLE organizations ADD COLUMN prorata_enabled boolean NOT NULL DEFAULT false;

-- Multa e juros são cobranças filhas da original (uma multa por cobrança; um juros por bloco de 30 dias).
ALTER TABLE charges ADD COLUMN parent_charge_id integer REFERENCES charges(id) ON DELETE RESTRICT;
ALTER TABLE charges ADD COLUMN late_block integer;
CREATE UNIQUE INDEX charges_late_once ON charges (parent_charge_id, kind, late_block)
  WHERE parent_charge_id IS NOT NULL AND cancelled_at IS NULL;

-- Boleto marcado como pago pode já registrar o pagamento.
ALTER TABLE boletos ADD COLUMN payment_id integer REFERENCES payments(id) ON DELETE SET NULL;

-- Manutenção cobrada do proprietário: o custo entra como desconto no repasse do mês.
ALTER TABLE maintenance_requests ADD COLUMN charge_owner boolean NOT NULL DEFAULT false;
ALTER TABLE maintenance_requests ADD COLUMN owner_deduct_period date;
ALTER TABLE owner_transfers ADD COLUMN maintenance_cents integer NOT NULL DEFAULT 0 CHECK (maintenance_cents >= 0);
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'owner_transfers'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%net_cents = (gross_cents - fee_cents)%'
  LOOP
    EXECUTE format('ALTER TABLE owner_transfers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE owner_transfers ADD CONSTRAINT owner_transfers_net_check CHECK (net_cents = gross_cents - fee_cents - maintenance_cents);

-- Conciliação bancária (extrato OFX/CSV).
CREATE TABLE bank_statements (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  filename text NOT NULL,
  source text NOT NULL CHECK (source IN ('ofx','csv')),
  imported_by integer REFERENCES users(id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bank_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  statement_id integer NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  fitid text NOT NULL,                       -- identificador do banco (ou hash da linha): impede importar duas vezes
  posted_at date NOT NULL,
  amount_cents integer NOT NULL,             -- positivo = crédito
  memo text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','conciliada','ignorada')),
  payment_id integer REFERENCES payments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fitid)
);
CREATE INDEX bank_lines_status ON bank_lines (organization_id, status, posted_at);

-- Rateio de despesas do imóvel entre as unidades ocupadas (gera uma cobrança "taxa" por unidade).
CREATE TABLE shared_expenses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id integer NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  description text NOT NULL,
  total_cents integer NOT NULL CHECK (total_cents > 0),
  competence date NOT NULL,
  due_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('igual','area')),
  cancelled_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shared_expense_shares (
  expense_id integer NOT NULL REFERENCES shared_expenses(id) ON DELETE CASCADE,
  unit_id integer NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  charge_id integer REFERENCES charges(id) ON DELETE SET NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (expense_id, unit_id)
);

ALTER TABLE bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_expense_shares ENABLE ROW LEVEL SECURITY;
