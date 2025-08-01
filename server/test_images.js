const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function testImages() {
  try {
    console.log('🔍 Testando sistema de imagens...');
    
    // Buscar item com código 3001908
    const itemResult = await pool.query('SELECT id, codigo, descricao FROM itens WHERE codigo = $1', ['3001908']);
    
    if (itemResult.rows.length === 0) {
      console.log('❌ Item 3001908 não encontrado');
      return;
    }
    
    const item = itemResult.rows[0];
    console.log('✅ Item encontrado:', item);
    
    // Verificar imagens existentes
    const imagensResult = await pool.query('SELECT * FROM imagens_itens WHERE item_id = $1', [item.id]);
    console.log('📸 Imagens existentes:', imagensResult.rows.length);
    
    imagensResult.rows.forEach((img, index) => {
      console.log(`   ${index + 1}. ID: ${img.id}, Nome: ${img.nome_arquivo}, Caminho: ${img.caminho}`);
    });
    
    // Adicionar imagem de teste se não existir
    if (imagensResult.rows.length === 0) {
      console.log('➕ Adicionando imagem de teste...');
      
      const testImage = {
        item_id: item.id,
        nome_arquivo: '3001908_1.png',
        caminho: '3001908_1.png',
        tipo: 'image/png',
        is_completo: false
      };
      
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo) VALUES ($1, $2, $3, $4, $5)',
        [testImage.item_id, testImage.nome_arquivo, testImage.caminho, testImage.tipo, testImage.is_completo]
      );
      
      console.log('✅ Imagem de teste adicionada');
    }
    
    console.log('✅ Teste concluído');
    
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await pool.end();
  }
}

testImages(); 