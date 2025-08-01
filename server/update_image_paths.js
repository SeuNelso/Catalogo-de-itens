const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function updateImagePaths() {
  try {
    console.log('🔄 Atualizando caminhos das imagens para URLs diretas do R2...');
    
    // Buscar todas as imagens que usam /api/imagem/
    const imagensResult = await pool.query(`
      SELECT id, nome_arquivo, caminho, item_id 
      FROM imagens_itens 
      WHERE caminho LIKE '/api/imagem/%'
    `);
    
    console.log(`📸 Encontradas ${imagensResult.rows.length} imagens para atualizar`);
    
    for (const img of imagensResult.rows) {
      // Extrair o nome do arquivo do caminho
      const filename = img.caminho.replace('/api/imagem/', '');
      
      // Criar URL direta do R2
      const r2Url = `https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com/catalogo-imagens/${filename}`;
      
      console.log(`   Atualizando imagem ${img.id}: ${img.caminho} → ${r2Url}`);
      
      // Atualizar o caminho
      await pool.query(
        'UPDATE imagens_itens SET caminho = $1 WHERE id = $2',
        [r2Url, img.id]
      );
    }
    
    console.log('✅ Caminhos das imagens atualizados com sucesso!');
    
    // Verificar resultado
    const updatedResult = await pool.query(`
      SELECT id, nome_arquivo, caminho 
      FROM imagens_itens 
      WHERE caminho LIKE 'https://%'
      ORDER BY id
    `);
    
    console.log('\n📋 Imagens atualizadas:');
    updatedResult.rows.forEach((img, index) => {
      console.log(`   ${index + 1}. ID: ${img.id}, Nome: ${img.nome_arquivo}`);
      console.log(`      Caminho: ${img.caminho}`);
    });
    
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await pool.end();
  }
}

updateImagePaths(); 