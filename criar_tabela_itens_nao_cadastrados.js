const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function criarTabelaItensNaoCadastrados() {
  try {
    console.log('=== CRIANDO TABELA ITENS_NAO_CADASTRADOS ===');
    
    // Criar tabela
    await pool.query(`
      CREATE TABLE IF NOT EXISTS itens_nao_cadastrados (
        id SERIAL PRIMARY KEY,
        codigo TEXT NOT NULL,
        descricao TEXT NOT NULL,
        armazens JSONB,
        data_importacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('✅ Tabela itens_nao_cadastrados criada com sucesso!');
    
    // Criar índices
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_codigo 
      ON itens_nao_cadastrados(codigo)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_itens_nao_cadastrados_data 
      ON itens_nao_cadastrados(data_importacao)
    `);
    
    console.log('✅ Índices criados com sucesso!');
    
    // Verificar se a tabela foi criada
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name = 'itens_nao_cadastrados'
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ Tabela confirmada no banco de dados!');
    } else {
      console.log('❌ Tabela não foi encontrada!');
    }
    
  } catch (error) {
    console.error('❌ Erro ao criar tabela:', error);
  } finally {
    await pool.end();
  }
}

criarTabelaItensNaoCadastrados(); 