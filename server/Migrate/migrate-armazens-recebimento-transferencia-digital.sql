-- Receção digital: transferência central → central cria tarefa espelho no armazém destino.
-- Quando false, ao "Entregar" a origem passa direto a Entregue (fluxo legado, sem interação no destino).
ALTER TABLE armazens
  ADD COLUMN IF NOT EXISTS recebimento_transferencia_digital BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN armazens.recebimento_transferencia_digital IS
  'Se true (default), destino central participa no fluxo de recebimento de mercadoria (tarefa espelho). Se false, envio inter-central sem coordenação digital no destino.';
