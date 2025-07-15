const path = require('path');
const { uploadToGoogleDrive, getPublicUrl } = require('./googleDriveConfig');

async function testUpload() {
  try {
    // Caminho da imagem de teste (coloque uma imagem na pasta server para testar)
    const filePath = path.join(__dirname, 'sua-imagem-teste.jpg');
    const fileName = 'teste_upload_' + Date.now() + '.jpg';
    const mimeType = 'image/jpeg';

    const result = await uploadToGoogleDrive(filePath, fileName, mimeType);
    console.log('Upload realizado com sucesso!');
    console.log('ID do arquivo:', result.fileId);
    const publicUrl = await getPublicUrl(result.fileId);
    console.log('URL pública:', publicUrl);
  } catch (error) {
    console.error('Erro ao fazer upload:', error);
  }
}

testUpload(); 