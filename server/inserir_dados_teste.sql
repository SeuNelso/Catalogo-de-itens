-- Script para inserir dados de teste na tabela itens_nao_cadastrados
-- Execute este script no seu banco de dados PostgreSQL

-- Inserir dados de teste
INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens) VALUES
('ITEM001', 'Parafuso sextavado M8x1.25 - 20mm - Aço inoxidável', '{"Armazém Central": 150, "Armazém Norte": 75, "Depósito Sul": 200}'),
('ITEM002', 'Porca hexagonal M8 - Aço carbono - Classe 8.8', '{"Armazém Central": 300, "Depósito Sul": 125}'),
('ITEM003', 'Arruela plana M8 - Aço inoxidável - Espessura 1.5mm', '{"Armazém Central": 500, "Armazém Norte": 250, "Depósito Sul": 300, "Depósito Leste": 150}'),
('ITEM004', 'Chave de fenda Phillips #2 - 150mm - Cabo ergonômico', '{"Armazém Central": 25, "Depósito Leste": 15}'),
('ITEM005', 'Alicate bico longo - 160mm - Aço cromo vanádio', '{"Armazém Central": 40, "Armazém Norte": 20}'),
('ITEM006', 'Fita isolante 3M - 19mm x 20m - Preto', '{"Armazém Central": 100, "Depósito Sul": 50}'),
('ITEM007', 'Cabo flexível 2x1.5mm² - 100m - PVC', '{"Depósito Sul": 30, "Depósito Leste": 20}'),
('ITEM008', 'Interruptor simples - 10A - Branco - 1 módulo', '{"Armazém Central": 200, "Armazém Norte": 100, "Depósito Leste": 75}'),
('ITEM009', 'Tomada 2P+T - 10A - Branco - 1 módulo', '{"Armazém Central": 150, "Depósito Sul": 80}'),
('ITEM010', 'Caixa de passagem 4x4 - PVC - Branca', '{"Armazém Central": 300, "Armazém Norte": 150, "Depósito Sul": 200, "Depósito Leste": 100}'),
('ITEM011', 'Conduíte rígido 20mm - 3m - PVC - Cinza', '{"Depósito Sul": 500, "Depósito Leste": 300}'),
('ITEM012', 'Lâmpada LED 9W - E27 - Branco quente - 2700K', '{"Armazém Central": 1000, "Armazém Norte": 500, "Depósito Sul": 750, "Depósito Leste": 400}'),
('ITEM013', 'Disjuntor monopolar - 16A - Curva C', '{"Armazém Central": 200, "Depósito Leste": 100}'),
('ITEM014', 'Quadro de distribuição 12 módulos - IP40', '{"Armazém Central": 50, "Depósito Sul": 25}'),
('ITEM015', 'Fio terra 16mm² - 100m - Verde/amarelo', '{"Depósito Sul": 20, "Depósito Leste": 15}')
ON CONFLICT (codigo) DO UPDATE SET 
  descricao = EXCLUDED.descricao,
  armazens = EXCLUDED.armazens,
  data_importacao = CURRENT_TIMESTAMP;

-- Verificar se os dados foram inseridos
SELECT COUNT(*) as total_registros FROM itens_nao_cadastrados;

-- Mostrar alguns registros
SELECT codigo, descricao, armazens, data_importacao FROM itens_nao_cadastrados LIMIT 5; 