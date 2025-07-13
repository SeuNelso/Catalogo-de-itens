const { authorize, uploadToGoogleDrive, getPublicUrl } = require('./server/googleDriveConfig');
const fs = require('fs');

async function testGoogleDriveAuth() {
  console.log('=== Teste de Autenticação Google Drive ===\n');
  
  try {
    // Teste 1: Verificar se o arquivo credentials.json existe
    console.log('1. Verificando arquivo credentials.json...');
    if (!fs.existsSync('credentials.json')) {
      console.error('❌ Arquivo credentials.json não encontrado!');
      console.log('Por favor, siga as instruções em GOOGLE_DRIVE_SETUP.md');
      return;
    }
    console.log('✅ Arquivo credentials.json encontrado');
    
    // Teste 2: Verificar se o arquivo é um JSON válido
    console.log('\n2. Verificando formato do arquivo...');
    try {
      const credentials = JSON.parse(fs.readFileSync('credentials.json'));
      console.log('✅ Arquivo JSON válido');
      
      // Verificar campos obrigatórios
      const requiredFields = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email'];
      const missingFields = requiredFields.filter(field => !credentials[field]);
      
      if (missingFields.length > 0) {
        console.error('❌ Campos obrigatórios ausentes:', missingFields);
        return;
      }
      console.log('✅ Todos os campos obrigatórios presentes');
      
    } catch (error) {
      console.error('❌ Erro ao ler arquivo JSON:', error.message);
      return;
    }
    
    // Teste 3: Testar autenticação
    console.log('\n3. Testando autenticação...');
    const auth = await authorize();
    if (!auth) {
      console.error('❌ Falha na autenticação');
      return;
    }
    console.log('✅ Autenticação bem-sucedida');
    
    // Teste 4: Testar acesso ao Google Drive
    console.log('\n4. Testando acesso ao Google Drive...');
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });
    
    try {
      const response = await drive.about.get({
        fields: 'user'
      });
      console.log('✅ Acesso ao Google Drive confirmado');
      console.log('   Usuário:', response.data.user.emailAddress);
    } catch (error) {
      console.error('❌ Erro ao acessar Google Drive:', error.message);
      return;
    }
    
    console.log('\n✅ Todos os testes passaram! O Google Drive está configurado corretamente.');
    console.log('\nAgora você pode usar o sistema para fazer upload de imagens.');
    
  } catch (error) {
    console.error('❌ Erro durante os testes:', error.message);
  }
}

// Executar teste
testGoogleDriveAuth(); 