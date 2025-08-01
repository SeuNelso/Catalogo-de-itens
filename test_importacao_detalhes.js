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

async function testarImportacaoDetalhes() {
  console.log('🔍 Testando se imagens importadas aparecem nos detalhes do item');
  console.log('=' .repeat(60));
  
  // 1. Listar imagens no bucket com padrão de código
  console.log('\n📋 1. Listando imagens no bucket...');
  try {
    const listResult = await s3Client.listObjectsV2({
      Bucket: bucket,
      MaxKeys: 20
    }).promise();
    
    if (listResult.Contents.length === 0) {
      console.log('⚠️  Nenhuma imagem encontrada no bucket');
      return;
    }
    
    console.log(`✅ Encontradas ${listResult.Contents.length} imagens no bucket:`);
    listResult.Contents.forEach((obj, index) => {
      console.log(`   ${index + 1}. ${obj.Key} (${obj.Size} bytes)`);
    });
    
    // 2. Extrair códigos únicos das imagens
    const codigos = new Set();
    listResult.Contents.forEach(obj => {
      const partes = obj.Key.split('_');
      if (partes.length > 0) {
        codigos.add(partes[0]);
      }
    });
    
    console.log('\n📝 2. Códigos encontrados nas imagens:');
    Array.from(codigos).forEach(codigo => {
      console.log(`   - ${codigo}`);
    });
    
    // 3. Testar busca por um código específico
    const codigoTeste = Array.from(codigos)[0];
    if (codigoTeste) {
      console.log(`\n🔍 3. Testando busca por código: ${codigoTeste}`);
      
      const searchResult = await s3Client.listObjectsV2({
        Bucket: bucket,
        Prefix: `${codigoTeste}_`
      }).promise();
      
      console.log(`✅ Encontradas ${searchResult.Contents.length} imagens para o código ${codigoTeste}:`);
      searchResult.Contents.forEach((obj, index) => {
        console.log(`   ${index + 1}. ${obj.Key}`);
      });
    }
    
    // 4. Instruções para teste manual
    console.log('\n📖 4. Como testar manualmente:');
    console.log('   a) Faça upload de imagens com padrão: CODIGO_NUMERO.extensao');
    console.log('   b) Exemplo: 3000003_1.jpg, 3000003_2.png');
    console.log('   c) Acesse a página "Importar Imagens Automáticas"');
    console.log('   d) Digite o código (ex: 3000003) e clique em "Buscar"');
    console.log('   e) Clique em "Importar" para adicionar ao item');
    console.log('   f) Verifique se as imagens aparecem nos detalhes do item');
    
    // 5. Verificar se há imagens com padrão correto
    console.log('\n🔍 5. Verificando padrão de nomenclatura:');
    const imagensComPadraoCorreto = listResult.Contents.filter(obj => {
      const partes = obj.Key.split('_');
      return partes.length >= 2 && /^\d+$/.test(partes[0]);
    });
    
    if (imagensComPadraoCorreto.length > 0) {
      console.log(`✅ ${imagensComPadraoCorreto.length} imagens com padrão correto:`);
      imagensComPadraoCorreto.forEach((obj, index) => {
        console.log(`   ${index + 1}. ${obj.Key}`);
      });
    } else {
      console.log('⚠️  Nenhuma imagem com padrão correto encontrada');
      console.log('💡 Dica: Use o padrão CODIGO_NUMERO.extensao (ex: 3000003_1.jpg)');
    }
    
  } catch (error) {
    console.error('❌ Erro ao listar imagens:', error.message);
  }
  
  console.log('\n✅ Teste concluído!');
}

// Executar o teste
testarImportacaoDetalhes().catch(console.error); 