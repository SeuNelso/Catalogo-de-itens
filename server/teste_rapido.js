const { Pool } = require('pg');

// Configuração do banco de dados
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testeRapido() {
  try {
    console.log('🧪 Teste rápido da funcionalidade de componentes...');
    
    // 1. Verificar se a tabela existe
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'itens_compostos'
      );
    `);
    
    if (!tableExists.rows[0].exists) {
      console.log('❌ Tabela itens_compostos não existe!');
      return;
    }
    
    console.log('✅ Tabela itens_compostos existe');
    
    // 2. Buscar alguns itens para teste
    const itens = await pool.query('SELECT id, codigo FROM itens LIMIT 3');
    console.log(`📊 Encontrados ${itens.rows.length} itens para teste`);
    
    if (itens.rows.length < 2) {
      console.log('❌ Precisa de pelo menos 2 itens para testar');
      return;
    }
    
    const item1 = itens.rows[0];
    const item2 = itens.rows[1];
    
    console.log(`📋 Item 1: ${item1.codigo} (ID: ${item1.id})`);
    console.log(`📋 Item 2: ${item2.codigo} (ID: ${item2.id})`);
    
    // 3. Testar inserção
    console.log('🔧 Testando inserção...');
    
    // Verificar se já existe
    const existing = await pool.query(
      'SELECT id FROM itens_compostos WHERE item_principal_id = $1 AND item_componente_id = $2',
      [item1.id, item2.id]
    );
    
    if (existing.rows.length > 0) {
      console.log('⚠️  Relação já existe, removendo primeiro...');
      await pool.query(
        'DELETE FROM itens_compostos WHERE item_principal_id = $1 AND item_componente_id = $2',
        [item1.id, item2.id]
      );
    }
    
    // Inserir
    const result = await pool.query(
      'INSERT INTO itens_compostos (item_principal_id, item_componente_id, quantidade_componente) VALUES ($1, $2, $3) RETURNING id',
      [item1.id, item2.id, 2]
    );
    
    console.log(`✅ Inserção bem-sucedida! ID: ${result.rows[0].id}`);
    
    // 4. Verificar se foi inserido
    const check = await pool.query(
      'SELECT * FROM itens_compostos WHERE id = $1',
      [result.rows[0].id]
    );
    
    if (check.rows.length > 0) {
      console.log('✅ Verificação: Item encontrado na tabela');
      console.log('📊 Dados:', check.rows[0]);
    } else {
      console.log('❌ Verificação: Item não encontrado na tabela');
    }
    
    // 5. Limpar teste
    await pool.query('DELETE FROM itens_compostos WHERE id = $1', [result.rows[0].id]);
    console.log('🧹 Teste limpo');
    
    console.log('✅ Teste concluído com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
  } finally {
    await pool.end();
  }
}

testeRapido();

