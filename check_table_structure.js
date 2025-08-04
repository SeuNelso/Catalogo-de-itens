const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function checkTableStructure() {
  try {
    console.log('=== ESTRUTURA DA TABELA ITENS ===');
    
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'itens' 
      ORDER BY ordinal_position
    `);
    
    result.rows.forEach((column, index) => {
      console.log(`${index + 1}. ${column.column_name} (${column.data_type}) ${column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });
    
    console.log('\n=== TOTAL DE COLUNAS ===');
    console.log(`Total: ${result.rows.length} colunas`);
    
  } catch (error) {
    console.error('❌ Erro ao verificar estrutura:', error);
  } finally {
    await pool.end();
  }
}

checkTableStructure(); 