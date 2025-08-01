const https = require('https');

// Teste da rota de imagens
const testImageRoute = async () => {
  const testFilename = '84696_1753283829061_Captura%20de%20tela%202025-07-15%20174409.png';
  const url = `http://localhost:5000/api/imagem/${testFilename}`;
  
  console.log('Testando rota de imagem:', url);
  
  try {
    const response = await fetch(url);
    console.log('Status:', response.status);
    console.log('Headers:', response.headers);
    
    if (response.ok) {
      console.log('✅ Rota de imagem funcionando corretamente');
    } else {
      console.log('❌ Erro na rota de imagem:', response.statusText);
    }
  } catch (error) {
    console.error('❌ Erro ao testar rota:', error.message);
  }
};

// Teste da URL do Cloudflare R2
const testR2Url = () => {
  const bucket = 'catalogo-imagens';
  const endpoint = 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com';
  const filename = '84696_1753283829061_Captura%20de%20tela%202025-07-15%20174409.png';
  
  const publicUrl = `https://${bucket}.${endpoint.replace('https://', '')}/${filename}`;
  console.log('URL pública do R2:', publicUrl);
  
  https.get(publicUrl, (res) => {
    console.log('Status R2:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    
    if (res.statusCode === 200) {
      console.log('✅ Imagem acessível diretamente no R2');
    } else {
      console.log('❌ Erro ao acessar imagem no R2');
    }
  }).on('error', (err) => {
    console.error('❌ Erro ao acessar R2:', err.message);
  });
};

console.log('=== Teste da Rota de Imagens ===');
testImageRoute();

console.log('\n=== Teste da URL do R2 ===');
testR2Url(); 