-- Base da API de integrações v1 (OAuth2 + auditoria + webhooks + idempotência)

CREATE TABLE IF NOT EXISTS integration_clients (
  id SERIAL PRIMARY KEY,
  client_id TEXT UNIQUE NOT NULL,
  client_secret_hash TEXT NOT NULL,
  nome_sistema TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_clients_ativo ON integration_clients (ativo);

CREATE TABLE IF NOT EXISTS integration_access_tokens (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES integration_clients(client_id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_access_tokens_client_id ON integration_access_tokens (client_id);
CREATE INDEX IF NOT EXISTS idx_integration_access_tokens_expires_at ON integration_access_tokens (expires_at);

CREATE TABLE IF NOT EXISTS integration_idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES integration_clients(client_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '48 hours'),
  UNIQUE (client_id, idempotency_key, method, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_integration_idempotency_expires_at ON integration_idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS integration_audit_log (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  client_id TEXT NULL,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_audit_created_at ON integration_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_integration_audit_client_id ON integration_audit_log (client_id);

CREATE TABLE IF NOT EXISTS integration_webhook_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES integration_clients(client_id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret_hash TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_subscriptions_client_id ON integration_webhook_subscriptions (client_id);
CREATE INDEX IF NOT EXISTS idx_integration_webhook_subscriptions_event_name ON integration_webhook_subscriptions (event_name);

CREATE TABLE IF NOT EXISTS integration_webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT NOT NULL REFERENCES integration_webhook_subscriptions(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMP NULL,
  last_error TEXT NULL,
  delivered_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_integration_webhook_deliveries_status ON integration_webhook_deliveries (status);
CREATE INDEX IF NOT EXISTS idx_integration_webhook_deliveries_next_retry_at ON integration_webhook_deliveries (next_retry_at);
