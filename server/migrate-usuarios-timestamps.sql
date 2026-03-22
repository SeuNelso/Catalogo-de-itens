-- created_at / updated_at: o trigger update_usuarios_updated_at (init-db) usa NEW.updated_at.
-- Bases criadas só com migrações antigas podem não ter estas colunas → erro "record new has no field updated_at".
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
