const AWS = require('aws-sdk');
require('dotenv').config();

// Configurar cliente S3 para Cloudflare R2
const s3Client = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  region: 'auto',
  signatureVersion: 'v4',
  s3ForcePathStyle: true
});

const bucket = process.env.R2_BUCKET;

async function testarExclusaoImagens() {
  console.log('🗑️  Testando funcionalidade de exclusão de imagens do bucket');
  console.log('=' .repeat(60));
  
  // 1. Listar imagens existentes
  console.log('\n📋 1. Listando imagens existentes no bucket...');
  try {
    const listResult = await s3Client.listObjectsV2({
      Bucket: bucket,
      MaxKeys: 5
    }).promise();
    
    if (listResult.Contents.length === 0) {
      console.log('⚠️  Nenhuma imagem encontrada no bucket para teste');
      return;
    }
    
    console.log(`✅ Encontradas ${listResult.Contents.length} imagens no bucket:`);
    listResult.Contents.forEach((obj, index) => {
      console.log(`   ${index + 1}. ${obj.Key} (${obj.Size} bytes)`);
    });
    
    // 2. Testar exclusão de uma imagem
    const imagemParaTestar = listResult.Contents[0];
    console.log(`\n🗑️  2. Testando exclusão da imagem: ${imagemParaTestar.Key}`);
    
    try {
      const deleteResult = await s3Client.deleteObject({
        Bucket: bucket,
        Key: imagemParaTestar.Key
      }).promise();
      
      console.log('✅ Imagem deletada com sucesso do bucket!');
      console.log('📊 Resultado:', deleteResult);
      
      // 3. Verificar se foi realmente deletada
      console.log('\n🔍 3. Verificando se a imagem foi realmente deletada...');
      const verifyResult = await s3Client.listObjectsV2({
        Bucket: bucket,
        Prefix: imagemParaTestar.Key
      }).promise();
      
      if (verifyResult.Contents.length === 0) {
        console.log('✅ Confirmação: Imagem não encontrada mais no bucket');
      } else {
        console.log('⚠️  Aviso: Imagem ainda encontrada no bucket');
      }
      
    } catch (error) {
      console.error('❌ Erro ao deletar imagem:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Erro ao listar imagens:', error.message);
  }

  // 4. Instruções de uso
  console.log('\n📖 4. Como funciona a exclusão de imagens:');
  console.log('   a) Na tela de editar item, clique no "×" da imagem');
  console.log('   b) A imagem será marcada para exclusão');
  console.log('   c) Ao salvar o item, a imagem será deletada do bucket');
  console.log('   d) A imagem também será removida do banco de dados');
  
  // 5. Endpoints da API
  console.log('\n🔗 5. Endpoints relacionados:');
  console.log('   PUT  /api/itens/:id - Atualizar item (inclui exclusão de imagens)');
  console.log('   DELETE /api/itens/:id - Excluir item completo');
  console.log('   DELETE /api/imagens/:id - Excluir imagem específica');
  
  console.log('\n✅ Teste concluído!');
}

// Executar o teste
testarExclusaoImagens().catch(console.error); 