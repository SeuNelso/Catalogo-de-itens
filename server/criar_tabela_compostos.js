const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function criarTabelaItensCompostos() {
  try {
         console.log('🔧 Criando tabela de composição de itens...');
    
    // Criar tabela para itens compostos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS itens_compostos (
        id SERIAL PRIMARY KEY,
        item_principal_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
        item_componente_id INTEGER NOT NULL REFERENCES itens(id) ON DELETE CASCADE,
        quantidade_componente DECIMAL(10,2) DEFAULT 1,
        data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(item_principal_id, item_componente_id)
      );
    `);
    
    // Criar índices para melhor performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_itens_compostos_principal ON itens_compostos(item_principal_id);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_itens_compostos_componente ON itens_compostos(item_componente_id);
    `);
    
         console.log('✅ Tabela de composição de itens criada com sucesso!');
    console.log('✅ Índices criados com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro ao criar tabela:', error);
  } finally {
    await pool.end();
  }
}

criarTabelaItensCompostos(); 