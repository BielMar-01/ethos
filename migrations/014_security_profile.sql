-- Segurança e perfil: sessões listáveis, troca de e-mail com verificação, 2FA (TOTP), foto de perfil,
-- limite de tentativas compartilhado entre instâncias e encerramento de conta (LGPD).

-- Sessões: de onde e quando (para a lista "Seus aparelhos" e o encerramento individual).
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN user_agent text;
ALTER TABLE sessions ADD COLUMN ip text;

-- Troca de e-mail: o e-mail novo só vale depois de confirmado pelo link enviado a ele.
ALTER TABLE users ADD COLUMN pending_email text;
ALTER TABLE users ADD COLUMN pending_email_at timestamptz;
-- Conta encerrada pelo próprio titular: dados pessoais apagados, vínculos e histórico financeiro preservados.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- Segundo fator (TOTP, RFC 6238). O segredo fica cifrado (AES-256-GCM, INTEGRATIONS_SECRET).
CREATE TABLE user_mfa (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc text NOT NULL,
  enabled_at timestamptz,            -- null = configurando (ainda não vale no login)
  last_step bigint,                  -- último passo de 30 s aceito (impede reutilizar o mesmo código)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,           -- SHA-256; o código aparece uma única vez
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

-- Desafio entre a senha correta e o código: ainda não é sessão. Curto, de uso único e com limite de erros.
CREATE TABLE mfa_challenges (
  id text PRIMARY KEY,               -- SHA-256 do token entregue ao navegador
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Foto de perfil (privada: só sai por rota autenticada, do próprio usuário).
CREATE TABLE user_avatars (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Limite de tentativas compartilhado entre instâncias (a chave é um SHA-256: nada de e-mail ou IP legível).
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_reset_idx ON rate_limits (reset_at);

ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
