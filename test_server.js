const http = require('http');

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.end();
  });
}

async function testServer() {
  try {
    console.log('=== TESTE DO SERVIDOR ===');
    
    // Testar se o servidor está respondendo
    const response = await makeRequest('http://localhost:5000');
    console.log('Status da resposta:', response.status);
    
    if (response.status === 200) {
      console.log('✅ Servidor está respondendo!');
    } else {
      console.log('❌ Servidor não está respondendo corretamente');
    }
    
  } catch (error) {
    console.error('❌ Erro ao conectar com o servidor:', error.message);
  }
}

testServer(); 