-- Índices e manutenção para melhor desempenho com muitos utilizadores concorrentes
-- Execute: npm run db:migrate:performance-indexes
-- Requisitos: tabelas usuarios, requisicoes e armazens_item já existentes (schema normal do projeto)

-- Login: alinhar com a query LOWER(TRIM(username)) e TRIM(numero_colaborador)
CREATE INDEX IF NOT EXISTS idx_usuarios_login_username_lower ON usuarios ((LOWER(TRIM(COALESCE(username, '')))));
CREATE INDEX IF NOT EXISTS idx_usuarios_login_numero_trim ON usuarios ((TRIM(COALESCE(numero_colaborador::text, ''))));

-- Listagens de requisições por origem (filtros frequentes + ordenação por data)
CREATE INDEX IF NOT EXISTS idx_requisicoes_origem_created ON requisicoes (armazem_origem_id, created_at DESC);

-- Stocks WH por item (detalhe do catálogo)
CREATE INDEX IF NOT EXISTS idx_armazens_item_item_id ON armazens_item (item_id);

-- Estatísticas do planner após criar índices
ANALYZE usuarios;
ANALYZE requisicoes;
ANALYZE armazens_item;
