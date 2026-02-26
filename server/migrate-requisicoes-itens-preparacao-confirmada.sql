-- Obrigatoriedade da separação: cada item deve ser explicitamente confirmado (incl. 0 quando sem stock)
ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS preparacao_confirmada BOOLEAN DEFAULT false;

COMMENT ON COLUMN requisicoes_itens.preparacao_confirmada IS 'True quando o utilizador confirmou a preparação deste item (quantidade pode ser 0)';
