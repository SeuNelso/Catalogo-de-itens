const { Pool } = require('pg');

// Conexão com PostgreSQL (Railway)
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function verificarSetores() {
  try {
    console.log('🔍 Verificando setores importados...\n');

    // Verificar total de setores
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM itens_setores');
    console.log(`📊 Total de setores na tabela: ${totalResult.rows[0].total}`);

    // Verificar itens com múltiplos setores
    const multiSetoresResult = await pool.query(`
      SELECT 
        i.codigo,
        i.nome,
        STRING_AGG(is2.setor, ', ') as setores,
        COUNT(is2.setor) as total_setores
      FROM itens i
      LEFT JOIN itens_setores is2 ON i.id = is2.item_id
      WHERE is2.setor IS NOT NULL
      GROUP BY i.id, i.codigo, i.nome
      HAVING COUNT(is2.setor) > 1
      ORDER BY i.codigo
      LIMIT 10
    `);

    console.log('\n📋 Itens com múltiplos setores:');
    multiSetoresResult.rows.forEach(row => {
      console.log(`  ${row.codigo}: ${row.setores} (${row.total_setores} setores)`);
    });

    // Verificar distribuição por setor
    const distribuicaoResult = await pool.query(`
      SELECT 
        setor,
        COUNT(*) as total_itens
      FROM itens_setores
      GROUP BY setor
      ORDER BY total_itens DESC
    `);

    console.log('\n📊 Distribuição por setor:');
    distribuicaoResult.rows.forEach(row => {
      console.log(`  ${row.setor}: ${row.total_itens} itens`);
    });

    // Verificar alguns exemplos específicos
    console.log('\n🔍 Exemplos de itens com setores:');
    const exemplosResult = await pool.query(`
      SELECT 
        i.codigo,
        STRING_AGG(is2.setor, ', ') as setores
      FROM itens i
      LEFT JOIN itens_setores is2 ON i.id = is2.item_id
      WHERE i.codigo IN ('3000020', '3000021', '3000022', '3000023', '3000024')
      GROUP BY i.id, i.codigo
      ORDER BY i.codigo
    `);

    exemplosResult.rows.forEach(row => {
      console.log(`  ${row.codigo}: ${row.setores || 'Sem setores'}`);
    });

  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await pool.end();
  }
}

verificarSetores();
