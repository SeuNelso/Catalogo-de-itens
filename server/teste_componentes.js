const { Pool } = require('pg');

// Configuração do banco de dados (mesma do servidor)
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testarComponentes() {
  try {
    console.log('🧪 Testando funcionalidade de componentes...');
    
    // 1. Verificar se a tabela existe
    console.log('1️⃣ Verificando se a tabela itens_compostos existe...');
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'itens_compostos'
      );
    `);
    
    if (tableCheck.rows[0].exists) {
      console.log('✅ Tabela itens_compostos existe');
    } else {
      console.log('❌ Tabela itens_compostos não existe');
      return;
    }
    
    // 2. Verificar se há itens cadastrados
    console.log('2️⃣ Verificando itens cadastrados...');
    const itens = await pool.query('SELECT id, codigo, descricao FROM itens LIMIT 5');
    console.log(`📊 Encontrados ${itens.rows.length} itens cadastrados`);
    
    if (itens.rows.length === 0) {
      console.log('❌ Não há itens cadastrados para testar');
      return;
    }
    
    // 3. Mostrar alguns itens disponíveis
    console.log('📋 Itens disponíveis para teste:');
    itens.rows.forEach((item, index) => {
      console.log(`   ${index + 1}. ID: ${item.id}, Código: ${item.codigo}`);
    });
    
    // 4. Verificar componentes existentes
    console.log('3️⃣ Verificando componentes existentes...');
    const componentes = await pool.query('SELECT COUNT(*) as total FROM itens_compostos');
    console.log(`📊 Total de componentes: ${componentes.rows[0].total}`);
    
    // 5. Testar inserção de um componente (se houver pelo menos 2 itens)
    if (itens.rows.length >= 2) {
      console.log('4️⃣ Testando inserção de componente...');
      const itemPrincipal = itens.rows[0];
      const itemComponente = itens.rows[1];
      
      console.log(`   Item principal: ${itemPrincipal.codigo} (ID: ${itemPrincipal.id})`);
      console.log(`   Item componente: ${itemComponente.codigo} (ID: ${itemComponente.id})`);
      
      // Verificar se já existe essa relação
      const existing = await pool.query(
        'SELECT id FROM itens_compostos WHERE item_principal_id = $1 AND item_componente_id = $2',
        [itemPrincipal.id, itemComponente.id]
      );
      
      if (existing.rows.length > 0) {
        console.log('⚠️  Relação já existe, pulando teste de inserção');
      } else {
        // Inserir componente de teste
        const result = await pool.query(
          'INSERT INTO itens_compostos (item_principal_id, item_componente_id, quantidade_componente) VALUES ($1, $2, $3) RETURNING id',
          [itemPrincipal.id, itemComponente.id, 2]
        );
        
        console.log(`✅ Componente inserido com sucesso! ID: ${result.rows[0].id}`);
        
        // Remover o componente de teste
        await pool.query(
          'DELETE FROM itens_compostos WHERE id = $1',
          [result.rows[0].id]
        );
        console.log('🧹 Componente de teste removido');
      }
    }
    
    console.log('✅ Teste concluído com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro durante o teste:', error);
  } finally {
    await pool.end();
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  testarComponentes();
}

module.exports = { testarComponentes };

