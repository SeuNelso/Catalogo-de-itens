BEGIN;

ALTER TABLE armazens
  ADD COLUMN IF NOT EXISTS armazem_central_vinculado_id INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_armazens_central_vinculado'
  ) THEN
    ALTER TABLE armazens
      ADD CONSTRAINT fk_armazens_central_vinculado
      FOREIGN KEY (armazem_central_vinculado_id)
      REFERENCES armazens(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_armazens_central_vinculado_id
  ON armazens(armazem_central_vinculado_id);

COMMIT;
