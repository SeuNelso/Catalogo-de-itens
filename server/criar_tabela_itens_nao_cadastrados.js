const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function criarTabela() {
  try {
    console.log('🔧 Criando tabela itens_nao_cadastrados...');
    
    // Ler o arquivo SQL
    const sqlPath = path.join(__dirname, 'criar_tabela_itens_nao_cadastrados.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    
    // Executar o SQL
    const result = await pool.query(sqlContent);
    
    console.log('✅ Tabela criada com sucesso!');
    console.log('📊 Resultados:', result.rows);
    
    // Verificar se a tabela foi criada
    const checkResult = await pool.query('SELECT COUNT(*) FROM itens_nao_cadastrados');
    console.log('📋 Total de registros na tabela:', checkResult.rows[0].count);
    
  } catch (error) {
    console.error('❌ Erro ao criar tabela:', error);
    console.error('❌ Stack trace:', error.stack);
  } finally {
    await pool.end();
  }
}

criarTabela(); 