const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testarFiltrarItensCadastrados() {
  try {
    console.log('🧪 Testando filtro de itens já cadastrados...');
    
    // 1. Verificar total de itens não cadastrados
    const totalNaoCadastrados = await pool.query('SELECT COUNT(*) as total FROM itens_nao_cadastrados');
    console.log(`📊 Total de itens não cadastrados: ${totalNaoCadastrados.rows[0].total}`);
    
    // 2. Verificar total de itens cadastrados
    const totalCadastrados = await pool.query('SELECT COUNT(*) as total FROM itens');
    console.log(`📊 Total de itens cadastrados: ${totalCadastrados.rows[0].total}`);
    
    // 3. Testar a query que filtra itens já cadastrados
    const result = await pool.query(`
      SELECT inc.* 
      FROM itens_nao_cadastrados inc
      WHERE NOT EXISTS (
        SELECT 1 FROM itens i WHERE i.codigo = inc.codigo
      )
      ORDER BY inc.data_importacao DESC
    `);
    
    console.log(`📊 Itens não cadastrados (após filtro): ${result.rows.length}`);
    
    // 4. Mostrar alguns exemplos
    if (result.rows.length > 0) {
      console.log('\n📝 Exemplos de itens não cadastrados:');
      result.rows.slice(0, 3).forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.codigo} - ${item.descricao}`);
      });
    }
    
    // 5. Verificar quantos itens foram filtrados
    const itensFiltrados = totalNaoCadastrados.rows[0].total - result.rows.length;
    console.log(`\n🔍 Itens filtrados (já cadastrados): ${itensFiltrados}`);
    
    // 6. Verificar se há itens que aparecem em ambas as tabelas
    const itensDuplicados = await pool.query(`
      SELECT inc.codigo, inc.descricao, i.codigo as codigo_cadastrado
      FROM itens_nao_cadastrados inc
      INNER JOIN itens i ON i.codigo = inc.codigo
      LIMIT 5
    `);
    
    if (itensDuplicados.rows.length > 0) {
      console.log('\n⚠️  Itens que aparecem em ambas as tabelas:');
      itensDuplicados.rows.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.codigo} - ${item.descricao}`);
      });
    } else {
      console.log('\n✅ Nenhum item duplicado encontrado!');
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
  } finally {
    await pool.end();
  }
}

testarFiltrarItensCadastrados(); 