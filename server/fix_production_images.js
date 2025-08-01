const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});

async function fixProductionImages() {
  try {
    console.log('🔧 Corrigindo imagens para produção...');
    
    // Buscar item 3001908
    const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', ['3001908']);
    
    if (itemResult.rows.length === 0) {
      console.log('❌ Item 3001908 não encontrado');
      return;
    }
    
    const itemId = itemResult.rows[0].id;
    console.log('✅ Item encontrado, ID:', itemId);
    
    // Criar diretório uploads se não existir
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('📁 Diretório uploads criado');
    }
    
    // Lista de imagens que precisam ser criadas
    const imagesToCreate = [
      { id: 47, nome: '3001908_1.png', caminho: '3001908_1.png' },
      { id: 48, nome: '3001908_2.png', caminho: '3001908_2.png' }
    ];
    
    for (const image of imagesToCreate) {
      console.log(`\n📸 Processando ${image.nome}...`);
      
      const localPath = path.join(uploadsDir, image.nome);
      
      // Verificar se a imagem já existe localmente
      if (fs.existsSync(localPath)) {
        console.log(`   ✅ Arquivo já existe: ${localPath}`);
      } else {
        console.log(`   🎨 Criando imagem: ${image.nome}`);
        
        // Criar canvas
        const canvas = createCanvas(400, 300);
        const ctx = canvas.getContext('2d');
        
        // Preencher fundo
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, 400, 300);
        
        // Adicionar texto
        ctx.fillStyle = '#333333';
        ctx.font = '24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('IMAGEM DE TESTE', 200, 120);
        ctx.fillText('Item 3001908', 200, 150);
        ctx.fillText(image.nome, 200, 180);
        
        // Adicionar borda
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 2;
        ctx.strokeRect(10, 10, 380, 280);
        
        // Salvar arquivo
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(localPath, buffer);
        
        console.log(`   ✅ Arquivo criado: ${localPath}`);
      }
      
      // Verificar se o banco de dados está correto
      const dbResult = await pool.query('SELECT caminho FROM imagens_itens WHERE id = $1', [image.id]);
      
      if (dbResult.rows.length > 0) {
        const currentPath = dbResult.rows[0].caminho;
        
        if (currentPath !== image.caminho) {
          console.log(`   🔄 Atualizando banco: ${currentPath} → ${image.caminho}`);
          await pool.query(
            'UPDATE imagens_itens SET caminho = $1 WHERE id = $2',
            [image.caminho, image.id]
          );
          console.log(`   ✅ Banco atualizado`);
        } else {
          console.log(`   ✅ Banco já está correto: ${currentPath}`);
        }
      }
    }
    
    // Verificar resultado final
    const imagensResult = await pool.query('SELECT * FROM imagens_itens WHERE item_id = $1', [itemId]);
    
    console.log('\n📋 Status final das imagens:');
    imagensResult.rows.forEach((img, index) => {
      const localExists = fs.existsSync(path.join(uploadsDir, img.nome_arquivo));
      console.log(`   ${index + 1}. ID: ${img.id}, Nome: ${img.nome_arquivo}`);
      console.log(`      Caminho: ${img.caminho}`);
      console.log(`      Arquivo local: ${localExists ? '✅ Existe' : '❌ Não existe'}`);
    });
    
    console.log('\n✅ Processo concluído!');
    console.log('💡 As imagens agora devem funcionar tanto em desenvolvimento quanto em produção');
    
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await pool.end();
  }
}

fixProductionImages(); 