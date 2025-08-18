const { Pool } = require('pg');

// Conexão com PostgreSQL (Railway)
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function limparSetores() {
  try {
    console.log('🗑️ Iniciando limpeza dos setores...');
    
    // Verificar quantos setores existem atualmente
    const checkResult = await pool.query('SELECT COUNT(*) as total FROM itens_setores');
    const totalSetores = parseInt(checkResult.rows[0].total);
    
    console.log(`📊 Total de setores encontrados: ${totalSetores}`);
    
    if (totalSetores === 0) {
      console.log('ℹ️ Tabela itens_setores já está vazia.');
      return;
    }
    
    // Mostrar alguns exemplos antes de limpar
    console.log('📋 Exemplos de setores que serão removidos:');
    const exemplosResult = await pool.query(`
      SELECT i.codigo, i.nome, STRING_AGG(is2.setor, ', ') as setores
      FROM itens i
      LEFT JOIN itens_setores is2 ON i.id = is2.item_id
      WHERE is2.setor IS NOT NULL
      GROUP BY i.id, i.codigo, i.nome
      LIMIT 5
    `);
    
    exemplosResult.rows.forEach(row => {
      console.log(`  - ${row.codigo}: ${row.setores}`);
    });
    
    // Confirmar com o usuário
    console.log('\n⚠️ ATENÇÃO: Esta operação irá remover TODOS os setores da tabela itens_setores.');
    console.log('Isso não afetará os dados dos itens, apenas os setores associados.');
    
    // Limpar todos os setores
    console.log('\n🧹 Removendo todos os setores...');
    const deleteResult = await pool.query('DELETE FROM itens_setores');
    
    console.log(`✅ Limpeza concluída! ${deleteResult.rowCount} registros removidos.`);
    
    // Verificar se a limpeza foi bem-sucedida
    const finalCheck = await pool.query('SELECT COUNT(*) as total FROM itens_setores');
    const finalTotal = parseInt(finalCheck.rows[0].total);
    
    if (finalTotal === 0) {
      console.log('✅ Tabela itens_setores está completamente vazia.');
      console.log('🎯 Agora você pode importar os setores corretos!');
    } else {
      console.log(`⚠️ Ainda restam ${finalTotal} registros na tabela.`);
    }
    
  } catch (error) {
    console.error('❌ Erro durante a limpeza:', error);
  } finally {
    await pool.end();
  }
}

limparSetores();
