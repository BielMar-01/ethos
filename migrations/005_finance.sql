-- Financeiro. Conceitos SEPARADOS (ver docs/CONTEXTO-ETHOS.md §8.6):
--   cobrança (charges)  → o que é devido;
--   pagamento (payments) → dinheiro recebido (com recibo);
--   baixa (payment_allocations) → quanto de cada pagamento quita cada cobrança;
--   repasse (owner_transfers) → o que é devolvido ao proprietário.
-- O status da cobrança (aberta/parcial/vencida/paga) é DERIVADO das baixas, nunca guardado.

-- Taxa de administração em pontos-base (1000 = 10%), usada nos repasses.
ALTER TABLE organizations
  ADD COLUMN admin_fee_bps integer NOT NULL DEFAULT 0 CHECK (admin_fee_bps BETWEEN 0 AND 10000);

CREATE TABLE charges (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('aluguel','multa','juros','taxa','outro')),
  description text NOT NULL,
  competence date NOT NULL,            -- 1º dia do mês de competência
  due_date date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  cancelled_at timestamptz,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- No máximo um aluguel ativo por contrato e competência (geração mensal idempotente).
CREATE UNIQUE INDEX charges_rent_once
  ON charges (lease_id, competence) WHERE kind = 'aluguel' AND cancelled_at IS NULL;

CREATE TABLE payments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lease_id integer NOT NULL REFERENCES leases(id) ON DELETE RESTRICT,
  received_at date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL CHECK (method IN ('pix','boleto','dinheiro','transferencia','cartao','outro')),
  reference text,
  receipt_number integer NOT NULL,
  receipt_content text NOT NULL,       -- recibo emitido: texto fixo do momento
  voided_at timestamptz,               -- estorno: preserva o histórico em vez de apagar
  void_reason text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, receipt_number),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

CREATE TABLE payment_allocations (
  payment_id integer NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  charge_id integer NOT NULL REFERENCES charges(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (payment_id, charge_id)
);

CREATE TABLE owner_transfers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id integer NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  period date NOT NULL,                -- 1º dia do mês dos recebimentos
  gross_cents integer NOT NULL CHECK (gross_cents >= 0),
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  net_cents integer NOT NULL CHECK (net_cents >= 0),
  fee_bps integer NOT NULL,            -- taxa aplicada na geração (fica registrada)
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago')),
  paid_at date,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, owner_id, period),
  CHECK (net_cents = gross_cents - fee_cents),
  CHECK ((status = 'pago') = (paid_at IS NOT NULL))
);

CREATE INDEX ON charges (organization_id, due_date);
CREATE INDEX ON charges (lease_id);
CREATE INDEX ON payments (organization_id, received_at);
CREATE INDEX ON payments (lease_id);
CREATE INDEX ON payment_allocations (charge_id);
CREATE INDEX ON owner_transfers (organization_id, period);

ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_transfers ENABLE ROW LEVEL SECURITY;
