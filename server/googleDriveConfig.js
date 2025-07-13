const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Configurações do Google Drive
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const CREDENTIALS_PATH = 'credentials.json';

// Função para autenticar com Google Drive usando conta de serviço
async function authorize() {
  try {
    // Verificar se existe arquivo de credenciais
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.error('Arquivo credentials.json não encontrado!');
      console.log('Para configurar o Google Drive:');
      console.log('1. Acesse https://console.developers.google.com/');
      console.log('2. Crie um projeto e habilite a Google Drive API');
      console.log('3. Crie credenciais de conta de serviço');
      console.log('4. Baixe o arquivo JSON e renomeie para credentials.json');
      console.log('5. Coloque o arquivo na raiz do projeto');
      return null;
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    
    // Usar conta de serviço para autenticação
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: SCOPES
    });

    return auth;
  } catch (error) {
    console.error('Erro na autenticação:', error);
    return null;
  }
}

// Função para fazer upload de arquivo para Google Drive
async function uploadToGoogleDrive(filePath, fileName, mimeType) {
  try {
    const auth = await authorize();
    if (!auth) {
      throw new Error('Falha na autenticação com Google Drive');
    }

    const drive = google.drive({ version: 'v3', auth });
    
    const fileMetadata = {
      name: fileName,
      parents: ['1l_72YDWWIGL9zP66eXLVJx4Ym_ONTB9r'] // ID da pasta no Google Drive
    };
    
    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };
    
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, webContentLink'
    });
    
    return {
      fileId: response.data.id,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink
    };
  } catch (error) {
    console.error('Erro no upload para Google Drive:', error);
    throw error;
  }
}

// Função para obter URL pública do arquivo
async function getPublicUrl(fileId) {
  try {
    const auth = await authorize();
    if (!auth) {
      throw new Error('Falha na autenticação com Google Drive');
    }

    const drive = google.drive({ version: 'v3', auth });
    
    // Tornar arquivo público
    await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
    
    // Retornar URL pública
    return `https://drive.google.com/uc?export=view&id=${fileId}`;
  } catch (error) {
    console.error('Erro ao tornar arquivo público:', error);
    throw error;
  }
}

// Função para deletar arquivo do Google Drive
async function deleteFromGoogleDrive(fileId) {
  try {
    const auth = await authorize();
    if (!auth) {
      throw new Error('Falha na autenticação com Google Drive');
    }

    const drive = google.drive({ version: 'v3', auth });
    await drive.files.delete({ fileId: fileId });
    
    return true;
  } catch (error) {
    console.error('Erro ao deletar arquivo do Google Drive:', error);
    throw error;
  }
}

module.exports = {
  uploadToGoogleDrive,
  getPublicUrl,
  deleteFromGoogleDrive,
  authorize
}; 