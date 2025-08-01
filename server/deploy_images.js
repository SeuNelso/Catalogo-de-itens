const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

async function deployImages() {
  try {
    console.log('🚀 Preparando imagens para deploy em produção...');
    
    // Criar diretório uploads se não existir
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('📁 Diretório uploads criado');
    }
    
    // Lista de imagens que precisam existir
    const imagesToCreate = [
      '3001908_1.png',
      '3001908_2.png'
    ];
    
    for (const imageName of imagesToCreate) {
      console.log(`\n📸 Verificando ${imageName}...`);
      
      const localPath = path.join(uploadsDir, imageName);
      
      if (fs.existsSync(localPath)) {
        console.log(`   ✅ Arquivo já existe: ${localPath}`);
        const stats = fs.statSync(localPath);
        console.log(`   📊 Tamanho: ${(stats.size / 1024).toFixed(2)} KB`);
      } else {
        console.log(`   🎨 Criando imagem: ${imageName}`);
        
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
        ctx.fillText(imageName, 200, 180);
        
        // Adicionar borda
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 2;
        ctx.strokeRect(10, 10, 380, 280);
        
        // Salvar arquivo
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(localPath, buffer);
        
        console.log(`   ✅ Arquivo criado: ${localPath}`);
        console.log(`   📊 Tamanho: ${(buffer.length / 1024).toFixed(2)} KB`);
      }
    }
    
    // Listar todos os arquivos na pasta uploads
    console.log('\n📋 Arquivos na pasta uploads:');
    const files = fs.readdirSync(uploadsDir);
    files.forEach((file, index) => {
      const filePath = path.join(uploadsDir, file);
      const stats = fs.statSync(filePath);
      console.log(`   ${index + 1}. ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
    });
    
    console.log('\n✅ Deploy de imagens concluído!');
    console.log('💡 Execute este script no servidor de produção após cada deploy');
    
  } catch (error) {
    console.error('❌ Erro:', error);
  }
}

deployImages(); 