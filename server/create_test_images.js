const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

// Configurar AWS S3 para Cloudflare R2
const s3Client = new AWS.S3({
  endpoint: 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com',
  accessKeyId: 'd18863b1a98e7a9ca8875305179ad718',
  secretAccessKey: 'd18863b1a98e7a9ca8875305179ad718',
  region: 'auto',
  signatureVersion: 'v4'
});

async function createTestImages() {
  try {
    console.log('🎨 Criando imagens de teste para o item 3001908...');
    
    // Criar diretório se não existir
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Criar duas imagens de teste
    const imageNames = ['3001908_1.png', '3001908_2.png'];
    
    for (const imageName of imageNames) {
      console.log(`\n📸 Criando ${imageName}...`);
      
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
      
      // Salvar arquivo local
      const localPath = path.join(uploadsDir, imageName);
      const buffer = canvas.toBuffer('image/png');
      fs.writeFileSync(localPath, buffer);
      
      console.log(`   ✅ Arquivo local criado: ${localPath}`);
      
      // Fazer upload para R2
      console.log(`   🔄 Fazendo upload para R2...`);
      
      const uploadParams = {
        Bucket: 'catalogo-imagens',
        Key: imageName,
        Body: buffer,
        ContentType: 'image/png',
        ACL: 'public-read'
      };
      
      try {
        const result = await s3Client.upload(uploadParams).promise();
        console.log(`   ✅ Upload concluído: ${result.Location}`);
      } catch (uploadError) {
        console.error(`   ❌ Erro no upload: ${uploadError.message}`);
      }
    }
    
    console.log('\n🎉 Processo concluído!');
    
  } catch (error) {
    console.error('❌ Erro:', error);
  }
}

createTestImages(); 