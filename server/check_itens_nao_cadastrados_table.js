const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function checkTable() {
  try {
    console.log('🔍 Verificando tabela itens_nao_cadastrados...');
    
    // Verificar se a tabela existe
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'itens_nao_cadastrados'
      );
    `);
    
    console.log('📋 Tabela existe:', tableExists.rows[0].exists);
    
    if (tableExists.rows[0].exists) {
      // Mostrar estrutura da tabela
      const structure = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_name = 'itens_nao_cadastrados'
        ORDER BY ordinal_position;
      `);
      
      console.log('🏗️ Estrutura da tabela:');
      structure.rows.forEach(col => {
        console.log(`  - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? '(NULL)' : '(NOT NULL)'}`);
      });
      
      // Contar registros
      const count = await pool.query('SELECT COUNT(*) FROM itens_nao_cadastrados');
      console.log('📊 Total de registros:', count.rows[0].count);
      
      // Mostrar alguns registros de exemplo
      const sample = await pool.query('SELECT * FROM itens_nao_cadastrados LIMIT 3');
      console.log('📝 Exemplos de registros:');
      sample.rows.forEach((row, index) => {
        console.log(`  ${index + 1}. Código: ${row.codigo}, Descrição: ${row.descricao}`);
      });
    } else {
      console.log('❌ Tabela itens_nao_cadastrados não existe!');
      console.log('💡 Você precisa criar a tabela primeiro.');
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar tabela:', error);
  } finally {
    await pool.end();
  }
}

checkTable(); 