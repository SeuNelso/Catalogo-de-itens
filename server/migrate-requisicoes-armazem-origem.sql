-- Migração: adicionar armazem_origem_id na tabela requisicoes
-- Fluxo: 1) Criar requisição (origem, itens, destino) 2) Preparar/Atender (localização)
-- Execute se a tabela requisicoes já existir sem armazem_origem_id

ALTER TABLE requisicoes ADD COLUMN IF NOT EXISTS armazem_origem_id INTEGER REFERENCES armazens(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_requisicoes_armazem_origem_id ON requisicoes(armazem_origem_id);
COMMENT ON COLUMN requisicoes.armazem_origem_id IS 'Armazém de origem dos itens (preenchido na criação)';
COMMENT ON COLUMN requisicoes.armazem_id IS 'Armazém de destino (viatura que receberá os itens)';
COMMENT ON COLUMN requisicoes.localizacao IS 'Localização no armazém destino (preenchida na etapa de preparação/atendimento)';
