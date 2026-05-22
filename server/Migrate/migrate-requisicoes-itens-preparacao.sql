-- Migração: preparação individual por item
-- Cada item da requisição pode ser preparado com: quantidade, localização de saída e de chegada

ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS quantidade_preparada INTEGER DEFAULT 0;
ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS localizacao_origem VARCHAR(255);
ALTER TABLE requisicoes_itens ADD COLUMN IF NOT EXISTS localizacao_destino VARCHAR(255);

COMMENT ON COLUMN requisicoes_itens.quantidade_preparada IS 'Quantidade já preparada/separada deste item';
COMMENT ON COLUMN requisicoes_itens.localizacao_origem IS 'Localização de onde o item está saindo';
COMMENT ON COLUMN requisicoes_itens.localizacao_destino IS 'Localização para onde o item vai';
