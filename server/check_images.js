const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function checkImages() {
  try {
    console.log('🔍 Verificando imagens no banco de dados...');
    
    // Buscar todas as imagens do item 3001908
    const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', ['3001908']);
    
    if (itemResult.rows.length === 0) {
      console.log('❌ Item 3001908 não encontrado');
      return;
    }
    
    const itemId = itemResult.rows[0].id;
    console.log('✅ Item encontrado, ID:', itemId);
    
    // Buscar imagens do item
    const imagensResult = await pool.query('SELECT * FROM imagens_itens WHERE item_id = $1', [itemId]);
    
    console.log(`📸 Encontradas ${imagensResult.rows.length} imagens:`);
    
    imagensResult.rows.forEach((img, index) => {
      console.log(`\n   ${index + 1}. ID: ${img.id}`);
      console.log(`      Nome: ${img.nome_arquivo}`);
      console.log(`      Caminho: ${img.caminho}`);
      console.log(`      Tipo: ${img.tipo}`);
      console.log(`      Completo: ${img.is_completo}`);
      
      // Testar se a URL é acessível
      if (img.caminho.startsWith('http')) {
        console.log(`      🔗 URL direta do R2`);
      } else if (img.caminho.startsWith('/api/imagem/')) {
        console.log(`      🔗 URL via API`);
      } else {
        console.log(`      📁 Arquivo local`);
      }
    });
    
    // Testar URLs específicas
    console.log('\n🧪 Testando URLs específicas...');
    
    const testUrls = [
      'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com/catalogo-imagens/3001908_1.png',
      'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com/catalogo-imagens/3001908_2.png'
    ];
    
    for (const url of testUrls) {
      console.log(`\n   Testando: ${url}`);
      try {
        const response = await fetch(url);
        console.log(`      Status: ${response.status} ${response.statusText}`);
        console.log(`      Content-Type: ${response.headers.get('content-type')}`);
        console.log(`      Content-Length: ${response.headers.get('content-length')}`);
      } catch (error) {
        console.log(`      ❌ Erro: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await pool.end();
  }
}

checkImages(); 