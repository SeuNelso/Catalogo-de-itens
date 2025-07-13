const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function testUpload() {
  console.log('=== Teste de Upload de Imagem ===\n');
  
  try {
    // Criar uma imagem de teste simples
    const testImagePath = 'test_image.png';
    
    // Se não existir, criar uma imagem de teste
    if (!fs.existsSync(testImagePath)) {
      console.log('Criando imagem de teste...');
      // Criar um arquivo de teste simples
      const testData = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      fs.writeFileSync(testImagePath, testData);
    }
    
    console.log('1. Preparando upload...');
    
    const form = new FormData();
    form.append('imagem', fs.createReadStream(testImagePath));
    
    console.log('2. Enviando para servidor...');
    
    const response = await fetch('http://localhost:5000/api/test-upload', {
      method: 'POST',
      body: form
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log('✅ Upload bem-sucedido!');
      console.log('File ID:', result.fileId);
      console.log('URL Pública:', result.publicUrl);
      console.log('Web View Link:', result.webViewLink);
      
      // Testar se a URL é acessível
      console.log('\n3. Testando acesso à imagem...');
      const imageResponse = await fetch(result.publicUrl);
      if (imageResponse.ok) {
        console.log('✅ Imagem acessível via URL pública');
      } else {
        console.log('⚠️  Imagem não acessível via URL pública');
      }
      
    } else {
      const error = await response.json();
      console.error('❌ Erro no upload:', error);
    }
    
  } catch (error) {
    console.error('❌ Erro durante o teste:', error.message);
  }
}

// Verificar se o servidor está rodando
async function checkServer() {
  try {
    const response = await fetch('http://localhost:5000/api/test-upload');
    if (response.status === 405) { // Method Not Allowed é esperado para GET
      console.log('✅ Servidor está rodando');
      return true;
    }
  } catch (error) {
    console.error('❌ Servidor não está rodando. Inicie com: npm start');
    return false;
  }
}

// Executar teste
async function runTest() {
  const serverRunning = await checkServer();
  if (serverRunning) {
    await testUpload();
  }
}

runTest(); 