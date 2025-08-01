const AWS = require('aws-sdk');
require('dotenv').config();

// Configurar cliente S3 para Cloudflare R2
const s3Client = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  region: 'auto',
  signatureVersion: 'v4'
});

const bucket = process.env.R2_BUCKET;

async function testarImportacaoImagens() {
  console.log('🚀 Testando funcionalidade de importação automática de imagens');
  console.log('=' .repeat(60));
  
  // 1. Listar imagens existentes no bucket
  console.log('\n📋 1. Listando imagens existentes no bucket...');
  try {
    const listResult = await s3Client.listObjectsV2({
      Bucket: bucket,
      MaxKeys: 10
    }).promise();
    
    console.log(`✅ Encontradas ${listResult.Contents.length} imagens no bucket:`);
    listResult.Contents.forEach((obj, index) => {
      console.log(`   ${index + 1}. ${obj.Key} (${obj.Size} bytes)`);
    });
  } catch (error) {
    console.error('❌ Erro ao listar imagens:', error.message);
  }

  // 2. Verificar padrão de nomenclatura
  console.log('\n📝 2. Verificando padrão de nomenclatura...');
  console.log('✅ Padrão esperado: CODIGO_NUMERO.extensao');
  console.log('   Exemplo: 3000003_1.jpg, 3000003_2.png, 3000003_3.webp');
  
  // 3. Testar busca por código específico
  const codigoTeste = '3000003';
  console.log(`\n🔍 3. Testando busca por código: ${codigoTeste}`);
  try {
    const searchResult = await s3Client.listObjectsV2({
      Bucket: bucket,
      Prefix: `${codigoTeste}_`
    }).promise();
    
    if (searchResult.Contents.length > 0) {
      console.log(`✅ Encontradas ${searchResult.Contents.length} imagens para o código ${codigoTeste}:`);
      searchResult.Contents.forEach((obj, index) => {
        console.log(`   ${index + 1}. ${obj.Key}`);
      });
    } else {
      console.log(`⚠️  Nenhuma imagem encontrada para o código ${codigoTeste}`);
      console.log('💡 Dica: Faça upload de imagens com o padrão correto no bucket');
    }
  } catch (error) {
    console.error('❌ Erro ao buscar imagens:', error.message);
  }

  // 4. Instruções de uso
  console.log('\n📖 4. Instruções de uso:');
  console.log('   a) Faça upload das imagens para o bucket Cloudflare R2');
  console.log('   b) Use a nomenclatura: CODIGO_NUMERO.extensao');
  console.log('   c) Exemplo: 3000003_1.jpg, 3000003_2.png');
  console.log('   d) Acesse a página "Importar Imagens" no sistema');
  console.log('   e) Digite o código do item e clique em "Buscar"');
  console.log('   f) Clique em "Importar" para adicionar as imagens ao item');
  
  // 5. Exemplo de URLs da API
  console.log('\n🔗 5. Endpoints da API:');
  console.log('   GET  /api/imagens-bucket/:codigo - Listar imagens do bucket');
  console.log('   POST /api/importar-imagens-automaticas - Importar imagens');
  console.log('   GET  /api/imagem/:filename - Proxy para visualizar imagens');
  
  console.log('\n✅ Teste concluído!');
}

// Executar o teste
testarImportacaoImagens().catch(console.error); 