const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Configuração do banco de dados (mesma do servidor)
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function criarTabelaItensCompostos() {
  try {
    console.log('🔧 Criando tabela itens_compostos...');
    
    // Ler o arquivo SQL
    const sqlPath = path.join(__dirname, 'criar_tabela_itens_compostos.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    
    // Executar o SQL
    await pool.query(sqlContent);
    
    console.log('✅ Tabela itens_compostos criada com sucesso!');
    
    // Verificar se a tabela foi criada
    const result = await pool.query('SELECT COUNT(*) as total FROM itens_compostos');
    console.log(`📊 Total de registros na tabela: ${result.rows[0].total}`);
    
  } catch (error) {
    console.error('❌ Erro ao criar tabela itens_compostos:', error);
  } finally {
    await pool.end();
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  criarTabelaItensCompostos();
}

module.exports = { criarTabelaItensCompostos };
