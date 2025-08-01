const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function adicionarColunaIsCompleto() {
  try {
    console.log('🔧 Adicionando coluna is_completo na tabela imagens_itens...');
    
    // Adicionar coluna is_completo
    await pool.query(`
      ALTER TABLE imagens_itens 
      ADD COLUMN IF NOT EXISTS is_completo BOOLEAN DEFAULT FALSE;
    `);
    
    console.log('✅ Coluna is_completo adicionada com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro ao adicionar coluna:', error);
  } finally {
    await pool.end();
  }
}

adicionarColunaIsCompleto(); 