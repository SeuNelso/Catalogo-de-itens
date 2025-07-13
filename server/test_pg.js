const { Client } = require('pg');

const client = new Client({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway'
});

client.connect()
  .then(() => {
    console.log('Conexão bem-sucedida!');
    return client.end();
  })
  .catch(err => {
    console.error('Erro ao conectar:', err);
  }); 