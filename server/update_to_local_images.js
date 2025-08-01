const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function updateToLocalImages() {
  try {
    console.log('🔄 Atualizando imagens para usar arquivos locais...');
    
    // Buscar item 3001908
    const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', ['3001908']);
    
    if (itemResult.rows.length === 0) {
      console.log('❌ Item 3001908 não encontrado');
      return;
    }
    
    const itemId = itemResult.rows[0].id;
    console.log('✅ Item encontrado, ID:', itemId);
    
    // Atualizar imagens para usar arquivos locais
    const imageUpdates = [
      { id: 47, nome: '3001908_1.png', caminho: '3001908_1.png' },
      { id: 48, nome: '3001908_2.png', caminho: '3001908_2.png' }
    ];
    
    for (const update of imageUpdates) {
      console.log(`\n📸 Atualizando imagem ${update.id}:`);
      console.log(`   Nome: ${update.nome}`);
      console.log(`   Caminho: ${update.caminho}`);
      
      await pool.query(
        'UPDATE imagens_itens SET caminho = $1 WHERE id = $2',
        [update.caminho, update.id]
      );
      
      console.log(`   ✅ Atualizado com sucesso`);
    }
    
    // Verificar resultado
    const imagensResult = await pool.query('SELECT * FROM imagens_itens WHERE item_id = $1', [itemId]);
    
    console.log('\n📋 Imagens atualizadas:');
    imagensResult.rows.forEach((img, index) => {
      console.log(`   ${index + 1}. ID: ${img.id}, Nome: ${img.nome_arquivo}`);
      console.log(`      Caminho: ${img.caminho}`);
    });
    
    console.log('\n✅ Processo concluído!');
    console.log('💡 As imagens agora serão servidas localmente via /api/imagem/');
    
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await pool.end();
  }
}

updateToLocalImages(); 