// Carregar variáveis de ambiente
require('dotenv').config({ path: require('path').join(__dirname, '.env') });


const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');


// Conexão com PostgreSQL
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const { uploadToS3 } = require('./s3Upload');

// Função para converter URL do Google Sheets para formato de exportação
function convertGoogleSheetsUrlToExport(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    const sheetId = match[1];
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx&gid=0`;
  }
  return null;
}

// Função para baixar arquivo de uma URL
function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(filePath);
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        resolve();
      });
      
      file.on('error', (err) => {
        fs.unlink(filePath, () => {}); // Deletar arquivo em caso de erro
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}
const vision = require('@google-cloud/vision');
const { detectLabelsFromS3 } = require('./rekognition');
const AWS = require('aws-sdk');
const https = require('https');
const http = require('http');

// Setores válidos disponíveis no sistema
const SETORES_VALIDOS = [
  'CLIENTE',
  'ENGENHARIA',
  'FIBRA',
  'FROTA',
  'IT',
  'LOGISTICA',
  'MARKETING',
  'MOVEL',
  'NOWO',
  'FERRAMENTA',
  'EPI',
  'EPC'
];

// Função helper para criar cliente S3 configurado
function createS3Client() {
  // Usar variáveis de ambiente (sem valores padrão hardcoded)
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY;
  const secretAccessKey = process.env.R2_SECRET_KEY;
  
  // Verificar se as credenciais estão configuradas
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.warn('⚠️ [S3] Credenciais R2 não configuradas. Funcionalidades de upload serão limitadas.');
    return null;
  }
  
  return new AWS.S3({
    endpoint: endpoint,
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    signatureVersion: 'v4',
    region: 'auto', // Voltando para 'auto' para Cloudflare R2
    s3ForcePathStyle: true,
    maxRetries: 3,
    httpOptions: {
      timeout: 30000,
      agent: new https.Agent({
        keepAlive: true,
        maxSockets: 50,
        rejectUnauthorized: false
      })
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-aqui';

// Middleware para verificar token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acesso necessário' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
};

// Middleware global para logar todas as requisições recebidas
app.use((req, res, next) => {
  
  next();
});

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Servir arquivos estáticos do React em produção
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
}

// Configuração do Multer para upload de imagens
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas imagens são permitidas!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  }
});

// --- Importação assíncrona de Excel com progresso em memória ---
const importStatus = {};
const { v4: uuidv4 } = require('uuid');

const excelUpload = multer({ dest: 'uploads/' });
app.post('/api/importar-excel', authenticateToken, excelUpload.single('arquivo'), async (req, res) => {
  
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem importar dados.' });
  }
  
  // Verificar se é importação via arquivo ou Google Sheets
  const googleSheetsUrl = req.body.googleSheetsUrl;
  const isGoogleSheets = googleSheetsUrl && googleSheetsUrl.trim();
  
  if (!req.file && !isGoogleSheets) {
    return res.status(400).json({ error: 'Arquivo não enviado ou URL do Google Sheets não fornecida.' });
  }
  const importId = uuidv4();
  importStatus[importId] = {
    status: 'iniciando',
    total: 0,
    processados: 0,
    erros: [],
    concluido: false,
    iniciadoEm: new Date(),
    terminadoEm: null
  };
  res.json({ message: 'Importação iniciada', importId });

  setImmediate(async () => {
    try {
      const XLSX = require('xlsx');
      const fs = require('fs');
      const https = require('https');
      const http = require('http');
      
      let workbook;
      let filePath;
      
      if (isGoogleSheets) {
        // Processar Google Sheets
        console.log('📊 Processando Google Sheets:', googleSheetsUrl);
        
        // Converter URL para formato de exportação
        const exportUrl = convertGoogleSheetsUrlToExport(googleSheetsUrl);
        if (!exportUrl) {
          throw new Error('URL do Google Sheets inválida');
        }
        
        // Download do arquivo do Google Sheets
        filePath = `uploads/google_sheets_${Date.now()}.xlsx`;
        await downloadFile(exportUrl, filePath);
        
        workbook = XLSX.readFile(filePath);
      } else {
        // Processar arquivo local
        workbook = XLSX.readFile(req.file.path);
        filePath = req.file.path;
      }
      
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      // Configurar para ignorar as primeiras 6 linhas (cabeçalho) e começar na linha 7
      const data = XLSX.utils.sheet_to_json(sheet, { 
        defval: '',
        range: 6 // Começar a partir da linha 7 (índice 6)
      });
      
      console.log(`📊 Importação iniciada: ${data.length} linhas de dados encontradas (ignorando cabeçalho das primeiras 6 linhas)`);
      
      importStatus[importId].status = 'importando';
      importStatus[importId].total = data.length;
      let processados = 0;
      const BATCH_SIZE = 50;
      // Coletar todos os códigos do arquivo
      const codigosAtivos = new Set(data.map(row => row['Artigo']?.toString().trim()).filter(Boolean));
      // Marcar todos os itens do banco como inativos inicialmente
      await pool.query('UPDATE itens SET ativo = false');
      // Marcar como ativo os itens presentes no arquivo
      if (codigosAtivos.size > 0) {
        await pool.query('UPDATE itens SET ativo = true WHERE codigo = ANY($1)', [Array.from(codigosAtivos)]);
      }
      for (let batchStart = 0; batchStart < data.length; batchStart += BATCH_SIZE) {
        const batch = data.slice(batchStart, batchStart + BATCH_SIZE);
        await Promise.all(batch.map(async (row, i) => {
          const idx = batchStart + i;
          try {
            const codigo = row['Artigo']?.toString().trim();
            const descricao = row['Descrição']?.toString().trim();
            const nome = descricao;
            const quantidade = Number(row['TOTAL']) || 0;
            const ordem_importacao = idx;
            if (!codigo || !nome) {
              importStatus[importId].erros.push({ codigo: codigo || 'N/A', descricao: nome || 'N/A', motivo: 'Artigo não cadastrado', linha: idx + 8 }); // +8 porque começamos na linha 7 (índice 6) + 2 para ajuste
              processados++;
              importStatus[importId].processados = processados;
              return;
            }
            // Verificar se o artigo já existe
            console.log('Verificando artigo:', codigo);
            const existe = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
            console.log('Resultado da query para', codigo, ':', existe.rows);
            // Coletar armazéns do row
            const armazens = {};
            Object.keys(row).forEach(col => {
              if (col.startsWith('WH')) {
                armazens[col] = Number(row[col]) || 0;
              }
            });
            if (!existe.rows.length) {
              // Inserir na tabela de itens não cadastrados
              try {
                // Primeiro verificar se já existe
                const existeNaoCadastrado = await pool.query('SELECT id FROM itens_nao_cadastrados WHERE codigo = $1', [codigo]);
                
                if (existeNaoCadastrado.rows.length === 0) {
                  // Inserir novo item
                  await pool.query(
                    'INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens) VALUES ($1, $2, $3)',
                    [codigo, nome, JSON.stringify(armazens)]
                  );
                  console.log(`📝 Item não cadastrado inserido: ${codigo} - ${nome}`);
                } else {
                  // Atualizar item existente
                  await pool.query(
                    'UPDATE itens_nao_cadastrados SET descricao = $1, armazens = $2, data_importacao = CURRENT_TIMESTAMP WHERE codigo = $3',
                    [nome, JSON.stringify(armazens), codigo]
                  );
                  console.log(`📝 Item não cadastrado atualizado: ${codigo} - ${nome}`);
                }
              } catch (insertError) {
                console.error(`❌ Erro ao inserir item não cadastrado ${codigo}:`, insertError);
              }
              
              importStatus[importId].erros.push({ codigo: codigo, descricao: nome || 'N/A', motivo: 'Artigo não cadastrado', linha: idx + 8, armazens }); // +8 porque começamos na linha 7 (índice 6) + 2 para ajuste
              processados++;
              importStatus[importId].processados = processados;
              return;
            }
            // Atualizar item existente
            await pool.query(
              'UPDATE itens SET nome = $1, descricao = $2, quantidade = $3, ordem_importacao = $4 WHERE codigo = $5',
              [nome, descricao, quantidade, ordem_importacao, codigo]
            );
            const itemId = existe.rows[0].id;
            // Deletar armazéns antigos
            await pool.query('DELETE FROM armazens_item WHERE item_id = $1', [itemId]);
            // Inserir armazéns
            const armazemEntries = Object.entries(armazens);
            for (const [armazem, qtd] of armazemEntries) {
              await pool.query('INSERT INTO armazens_item (item_id, armazem, quantidade) VALUES ($1, $2, $3)', [itemId, armazem, qtd]);
            }
            processados++;
            importStatus[importId].processados = processados;
          } catch (err) {
            importStatus[importId].erros.push({ codigo: row['Artigo'] || 'N/A', descricao: row['Descrição'] || 'N/A', motivo: 'Erro ao importar', erro: err?.message || String(err), linha: idx + 8 }); // +8 porque começamos na linha 7 (índice 6) + 2 para ajuste
            processados++;
            importStatus[importId].processados = processados;
          }
        }));
      }
      
      // Limpar arquivo temporário
      if (isGoogleSheets && filePath) {
        fs.unlinkSync(filePath);
      } else if (req.file && req.file.path) {
        fs.unlinkSync(req.file.path);
      }
      
      importStatus[importId].status = 'concluido';
      importStatus[importId].concluido = true;
      importStatus[importId].terminadoEm = new Date();
    } catch (error) {
      importStatus[importId].status = 'erro';
      importStatus[importId].erros.push({ erro: error.message });
      importStatus[importId].terminadoEm = new Date();
      
      // Limpar arquivo temporário em caso de erro
      if (isGoogleSheets && filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkError) {
          console.error('Erro ao remover arquivo temporário:', unlinkError);
        }
      }
    }
  });
});

// Endpoint para consultar status da importação
app.get('/api/importar-excel-status/:id', authenticateToken, (req, res) => {
  const importId = req.params.id;
  if (!importStatus[importId]) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }
  res.json(importStatus[importId]);
});

// Endpoint para consultar status da importação de itens
app.get('/api/importar-itens-status/:importId', authenticateToken, (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const { importId } = req.params;
  
  // Teste temporário para simular dados de progresso
  if (importId === 'test-id') {
    return res.json({
      status: 'progresso',
      total: 100,
      processados: Math.floor(Math.random() * 100),
      cadastrados: 10,
      ignorados: 5,
      erros: []
    });
  }
  
  const status = importStatus[importId];
  
  if (!status) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }

  res.json(status);
});

// --- Importação de novos itens via Excel ---
const excelUploadItens = multer({ dest: 'uploads/' });
app.post('/api/importar-itens', authenticateToken, excelUploadItens.single('arquivo'), async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem importar itens.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }
  const XLSX = require('xlsx');
  const fs = require('fs');
  const { v4: uuidv4 } = require('uuid');
  const importId = uuidv4();
  importStatus[importId] = {
    status: 'iniciando',
    total: 0,
    processados: 0,
    erros: [],
    cadastrados: 0,
    ignorados: 0,
    concluido: false,
    iniciadoEm: new Date(),
    terminadoEm: null
  };
  res.json({ importId });
  setImmediate(async () => {
    try {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      importStatus[importId].status = 'progresso';
      importStatus[importId].total = data.length;
      let cadastrados = 0;
      let ignorados = 0;
      let processados = 0;
      // Buscar todos os códigos já existentes
      const { rows: existentes } = await pool.query('SELECT codigo FROM itens');
      const codigosExistentes = new Set(existentes.map(e => e.codigo));
      // Função para processar um item
      async function processarLinha(row, idx) {
        try {
          const codigo = row['Artigo']?.toString().trim();
          const descricao = row['Descrição']?.toString().trim();
          const nome = descricao;
          const categoria = row['Categoria']?.toString().trim() || 'Sem categoria';
          const quantidade = Number(row['TOTAL']) || 0;
          
          // Novos campos do template atualizado (apenas colunas que existem na tabela)
          const preco = row['Preço'] ? Number(row['Preço']) : null;
          const localizacao = row['Localização']?.toString().trim() || null;
          const observacoes = row['Observações']?.toString().trim() || null;
          const familia = row['Família']?.toString().trim() || null;
          const subfamilia = row['Subfamília']?.toString().trim() || null;
          const setor = row['Setor']?.toString().trim() || null;
          const comprimento = row['Comprimento'] ? Number(row['Comprimento']) : null;
          const largura = row['Largura'] ? Number(row['Largura']) : null;
          const altura = row['Altura'] ? Number(row['Altura']) : null;
          const unidade = row['Unidade']?.toString().trim() || null;
          const peso = row['Peso']?.toString().trim() || null;
          const unidadePeso = row['Unidade Peso']?.toString().trim() || null;
          const unidadeArmazenamento = row['Unidade Armazenamento']?.toString().trim() || null;
          const tipocontrolo = row['Tipo Controle']?.toString().trim() || null;
          
          // Debug: Log dos valores para verificar se estão sendo lidos corretamente
          console.log('Debug - Valores lidos do Excel:', {
            codigo,
            familia: row['Família'],
            subfamilia: row['Subfamília'],
            unidadeArmazenamento: row['Unidade Armazenamento'],
            tipocontrolo: row['Tipo Controle'],
            observacoes: row['Observações']
          });
          
          if (!codigo || !nome) {
            importStatus[importId].erros.push({ linha: idx + 2, motivo: 'Código ou descrição ausente', codigo: codigo || 'N/A' });
            processados++;
            importStatus[importId].processados = processados;
            return;
          }
          if (codigosExistentes.has(codigo)) {
            ignorados++;
            processados++;
            importStatus[importId].ignorados = ignorados;
            importStatus[importId].processados = processados;
            return;
          }
          // Inserir novo item com todos os campos (apenas colunas que existem)
          console.log('Inserindo item com valores:', {
            nome, descricao, categoria, codigo, quantidade, preco,
            localizacao, observacoes, familia, subfamilia, setor, comprimento,
            largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento, tipocontrolo
          });
          
          const result = await pool.query(
            `INSERT INTO itens (
              nome, descricao, categoria, codigo, quantidade, preco, 
              localizacao, observacoes, familia, subfamilia, setor, comprimento, 
              largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING id`,
            [nome, descricao, categoria, codigo, quantidade, preco, 
             localizacao, observacoes, familia, subfamilia, setor, comprimento, 
             largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento, tipocontrolo]
          );
          const itemId = result.rows[0].id;
          // Inserir armazéns (colunas WH) em paralelo
          const armazens = {};
          Object.keys(row).forEach(col => {
            if (col.startsWith('WH')) {
              armazens[col] = Number(row[col]) || 0;
            }
          });
          await Promise.all(Object.entries(armazens).map(([armazem, qtd]) =>
            pool.query('INSERT INTO armazens_item (item_id, armazem, quantidade) VALUES ($1, $2, $3)', [itemId, armazem, qtd])
          ));
          cadastrados++;
          processados++;
          importStatus[importId].cadastrados = cadastrados;
          importStatus[importId].processados = processados;
          codigosExistentes.add(codigo); // Evita duplicidade no mesmo arquivo
        } catch (err) {
          importStatus[importId].erros.push({ linha: idx + 2, motivo: 'Erro ao cadastrar', erro: err?.message || String(err) });
          processados++;
          importStatus[importId].processados = processados;
        }
      }
      // Processar em lotes de 20
      const BATCH_SIZE = 20;
      for (let batchStart = 0; batchStart < data.length; batchStart += BATCH_SIZE) {
        const batch = data.slice(batchStart, batchStart + BATCH_SIZE);
        await Promise.all(batch.map((row, i) => processarLinha(row, batchStart + i)));
      }
      fs.unlinkSync(req.file.path);
      importStatus[importId].status = 'concluido';
      importStatus[importId].concluido = true;
      importStatus[importId].terminadoEm = new Date();
    } catch (error) {
      importStatus[importId].status = 'erro';
      importStatus[importId].erros.push({ erro: error.message });
      importStatus[importId].terminadoEm = new Date();
    }
  });
});

// --- Download do template de importação ---
app.get('/api/download-template', authenticateToken, (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  try {
    const XLSX = require('xlsx');
    
    // Criar dados de exemplo para o template (apenas colunas que existem na tabela)
    const dadosExemplo = [
      {
        'Artigo': 'ART001',
        'Descrição': 'Produto de exemplo',
        'Categoria': 'Categoria exemplo',
        'Preço': 100.50,
        'TOTAL': 10,
        'Localização': 'Prateleira A1',
        'Observações': 'Observações do item',
        'Família': 'Família exemplo',
        'Subfamília': 'Subfamília exemplo',
        'Setor': 'Setor exemplo',
        'Comprimento': 10.5,
        'Largura': 5.2,
        'Altura': 3.1,
        'Unidade': 'cm',
        'Peso': '2.5',
        'Unidade Peso': 'kg',
        'Unidade Armazenamento': 'un',
        'Tipo Controle': 'Manual',
        'WH1': 5,
        'WH2': 3,
        'WH3': 2
      }
    ];

    // Criar workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(dadosExemplo);

    // Definir largura das colunas (apenas colunas que existem na tabela)
    const colWidths = [
      { wch: 12 }, // Artigo
      { wch: 30 }, // Descrição
      { wch: 15 }, // Categoria
      { wch: 10 }, // Preço
      { wch: 8 },  // TOTAL
      { wch: 15 }, // Localização
      { wch: 25 }, // Observações
      { wch: 15 }, // Família
      { wch: 15 }, // Subfamília
      { wch: 15 }, // Setor
      { wch: 12 }, // Comprimento
      { wch: 12 }, // Largura
      { wch: 12 }, // Altura
      { wch: 10 }, // Unidade
      { wch: 10 }, // Peso
      { wch: 15 }, // Unidade Peso
      { wch: 20 }, // Unidade Armazenamento
      { wch: 15 }, // Tipo Controle
      { wch: 8 },  // WH1
      { wch: 8 },  // WH2
      { wch: 8 }   // WH3
    ];
    worksheet['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Template');

    // Gerar buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template_importacao_itens.xlsx"');
    res.send(buffer);
  } catch (error) {
    console.error('Erro ao gerar template:', error);
    res.status(500).json({ error: 'Erro ao gerar template.' });
  }
});

// --- Importação de dados dos itens existentes ---
const dadosItensUpload = multer({ dest: 'uploads/' });
app.post('/api/importar-dados-itens', authenticateToken, dadosItensUpload.single('arquivo'), async (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem importar dados.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }

  const importId = uuidv4();
  importStatus[importId] = {
    status: 'iniciando',
    total: 0,
    processados: 0,
    atualizados: 0,
    ignorados: 0,
    erros: [],
    concluido: false,
    iniciadoEm: new Date(),
    terminadoEm: null
  };

  res.json({ 
    message: 'Importação de dados iniciada', 
    importId,
    details: 'Os dados serão processados em segundo plano'
  });

  setImmediate(async () => {
    try {
      const XLSX = require('xlsx');
      const fs = require('fs');
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      importStatus[importId].status = 'importando';
      importStatus[importId].total = data.length;
      let processados = 0;
      let atualizados = 0;
      let ignorados = 0;

      for (const row of data) {
        try {
          const codigo = row['Código']?.toString().trim();
          if (!codigo) {
            importStatus[importId].erros.push({ 
              linha: processados + 2, 
              motivo: 'Código não informado' 
            });
            processados++;
            importStatus[importId].processados = processados;
            continue;
          }

          // Verificar se o item existe
          const itemExists = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
          if (itemExists.rows.length === 0) {
            importStatus[importId].erros.push({ 
              codigo, 
              linha: processados + 2, 
              motivo: 'Item não encontrado no sistema' 
            });
            ignorados++;
            processados++;
            importStatus[importId].processados = processados;
            continue;
          }

          const itemId = itemExists.rows[0].id;

          // Preparar dados para atualização
          const updateData = {};
          
          // Mapeamento específico dos nomes das colunas do template para os campos do banco
          const mapeamentoCampos = {
            'Família': 'familia',
            'Subfamília': 'subfamilia', 
            'Setor': 'setor',
            'Comprimento': 'comprimento',
            'Largura': 'largura',
            'Altura': 'altura',
            'Unidade': 'unidade',
            'Peso': 'peso',
            'Unidade Peso': 'unidadePeso',
            'Unidade Armazenamento': 'unidadearmazenamento',
            'Observações': 'observacoes'
          };

          // Tentar mapear cada campo
          Object.entries(mapeamentoCampos).forEach(([nomeColuna, campoBanco]) => {
            const valor = row[nomeColuna];
            if (valor && valor.toString().trim() !== '') {
              updateData[campoBanco] = valor.toString().trim();
            }
          });

          // Se há dados para atualizar
          if (Object.keys(updateData).length > 0) {
            const setClause = Object.keys(updateData).map((key, index) => `${key} = $${index + 2}`).join(', ');
            const values = Object.values(updateData);
            
            await pool.query(
              `UPDATE itens SET ${setClause} WHERE id = $1`,
              [itemId, ...values]
            );
            atualizados++;
          } else {
            ignorados++;
          }

          processados++;
          importStatus[importId].processados = processados;
          importStatus[importId].atualizados = atualizados;
          importStatus[importId].ignorados = ignorados;

        } catch (err) {
          importStatus[importId].erros.push({ 
            codigo: row['Código'] || 'N/A', 
            linha: processados + 2, 
            motivo: 'Erro ao processar linha',
            erro: err.message 
          });
          processados++;
          importStatus[importId].processados = processados;
        }
      }

      fs.unlinkSync(req.file.path);
      importStatus[importId].status = 'concluido';
      importStatus[importId].concluido = true;
      importStatus[importId].terminadoEm = new Date();

    } catch (error) {
      importStatus[importId].status = 'erro';
      importStatus[importId].erros.push({ erro: error.message });
      importStatus[importId].terminadoEm = new Date();
    }
  });
});

// Endpoint para consultar status da importação de dados
app.get('/api/importar-dados-itens-status/:id', authenticateToken, (req, res) => {
  const importId = req.params.id;
  if (!importStatus[importId]) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }
  res.json(importStatus[importId]);
});

// Inicialização do banco de dados
// const db = new sqlite3.Database('catalogo.db');

// Criar tabelas
// const db = new sqlite3.Database('catalogo.db');

// Rotas da API

// Autenticação
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username e password são obrigatórios' });
  }

  pool.query('SELECT * FROM usuarios WHERE LOWER(username) = LOWER($1)', [username], (err, result) => {
    if (err) {
      console.error('[LOGIN] Erro no banco:', err.message);
      return res.status(500).json({ error: 'Erro ao conectar. Verifique se o banco está configurado e se a tabela usuarios existe (com colunas username e password).', details: process.env.NODE_ENV === 'development' ? err.message : undefined });
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    const user = result.rows[0];
    const hash = user.password || user.senha;
    if (!hash) {
      console.error('[LOGIN] Usuário sem senha no banco (coluna password/senha). Execute a migração migrate-usuarios-username-password.sql');
      return res.status(500).json({ error: 'Configuração do usuário inválida. Execute as migrações do banco.' });
    }

    let validPassword = false;
    try {
      validPassword = bcrypt.compareSync(password, hash);
    } catch (bcryptErr) {
      console.error('[LOGIN] Erro ao verificar senha:', bcryptErr.message);
      return res.status(500).json({ error: 'Erro ao validar senha.' });
    }
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    try {
      const token = jwt.sign(
        { id: user.id, username: user.username || user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        message: 'Login realizado com sucesso',
        token,
        user: {
          id: user.id,
          username: user.username || user.email,
          nome: user.nome,
          role: user.role
        }
      });
    } catch (jwtErr) {
      console.error('[LOGIN] Erro ao gerar token:', jwtErr.message);
      return res.status(500).json({ error: 'Erro ao gerar sessão.' });
    }
  });
});

// Verificar token
app.get('/api/verify-token', authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Listar todos os itens (público) COM paginação
app.get('/api/itens', (req, res) => {
  const incluirInativos = req.query.incluirInativos === 'true';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const searchTerm = req.query.search || '';
  
  // Parâmetros de filtro
  const familia = req.query.familia || '';
  const subfamilia = req.query.subfamilia || '';
  const setor = req.query.setor || '';
  const categoria = req.query.categoria || '';
  const quantidadeMin = req.query.quantidadeMin || '';
  const quantidadeMax = req.query.quantidadeMax || '';
  const unidadeArmazenamento = req.query.unidadeArmazenamento || '';
  const tipocontrolo = req.query.tipocontrolo || '';
  
  // Parâmetros de ordenação
  const sortBy = req.query.sortBy || '';
  const sortOrder = req.query.sortOrder || 'asc';
  
  let whereConditions = [];
  let params = [];
  let paramIndex = 1;
  
  // Condição para itens ativos/inativos
  if (!incluirInativos) {
    whereConditions.push('i.ativo = true');
  }
  
  // Condição de pesquisa
  if (searchTerm.trim()) {
    whereConditions.push(`(LOWER(i.codigo) LIKE LOWER($${paramIndex}) OR LOWER(i.nome) LIKE LOWER($${paramIndex}))`);
    params.push(`%${searchTerm.trim()}%`);
    paramIndex++;
  }
  
  // Filtros adicionais
  if (familia.trim()) {
    whereConditions.push(`LOWER(i.familia) LIKE LOWER($${paramIndex})`);
    params.push(`%${familia.trim()}%`);
    paramIndex++;
  }
  
  if (subfamilia.trim()) {
    whereConditions.push(`LOWER(i.subfamilia) LIKE LOWER($${paramIndex})`);
    params.push(`%${subfamilia.trim()}%`);
    paramIndex++;
  }
  
  // Processar múltiplos filtros de setor
  const setoresFiltro = req.query.setor ? (Array.isArray(req.query.setor) ? req.query.setor : [req.query.setor]) : [];
  if (setoresFiltro.length > 0) {
    const setoresConditions = setoresFiltro.map((setor, index) => {
      const paramPos = paramIndex + index;
      return `EXISTS (
        SELECT 1 FROM itens_setores is2 
        WHERE is2.item_id = i.id 
        AND LOWER(is2.setor) LIKE LOWER($${paramPos})
      )`;
    });
    whereConditions.push(`(${setoresConditions.join(' OR ')})`);
    setoresFiltro.forEach(setor => {
      params.push(`%${setor.trim()}%`);
    });
    paramIndex += setoresFiltro.length;
  }
  
  if (categoria.trim()) {
    whereConditions.push(`LOWER(i.categoria) LIKE LOWER($${paramIndex})`);
    params.push(`%${categoria.trim()}%`);
    paramIndex++;
  }
  
  if (quantidadeMin.trim()) {
    whereConditions.push(`i.quantidade >= $${paramIndex}`);
    params.push(parseInt(quantidadeMin.trim()));
    paramIndex++;
  }
  
  if (quantidadeMax.trim()) {
    whereConditions.push(`i.quantidade <= $${paramIndex}`);
    params.push(parseInt(quantidadeMax.trim()));
    paramIndex++;
  }
  
  if (unidadeArmazenamento.trim()) {
    whereConditions.push(`LOWER(i.unidadeArmazenamento) LIKE LOWER($${paramIndex})`);
    params.push(`%${unidadeArmazenamento.trim()}%`);
    paramIndex++;
  }
  
  if (tipocontrolo.trim()) {
    whereConditions.push(`LOWER(i.tipocontrolo) LIKE LOWER($${paramIndex})`);
    params.push(`%${tipocontrolo.trim()}%`);
    paramIndex++;
  }
  
  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
  
  // Query para contar total de itens
  const countQuery = `
    SELECT COUNT(DISTINCT i.id) as total
    FROM itens i
    LEFT JOIN itens_setores is2 ON i.id = is2.item_id
    ${whereClause}
  `;
  
  // Construir cláusula ORDER BY
  let orderByClause = '';
  if (sortBy && ['codigo', 'nome', 'quantidade', 'familia', 'subfamilia', 'categoria'].includes(sortBy)) {
    const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
    orderByClause = `ORDER BY i.${sortBy} ${direction}`;
  } else if (sortBy === 'setor') {
    const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
    orderByClause = `ORDER BY STRING_AGG(DISTINCT is2.setor, ', ') ${direction}`;
  } else {
    // Ordenação padrão
    orderByClause = `ORDER BY 
      (i.codigo ~ '^[0-9]') DESC, -- Prioriza códigos que começam com número
      i.codigo ASC,
      i.ordem_importacao ASC, 
      i.data_cadastro DESC`;
  }

  // Query principal com paginação
  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens,
           COUNT(DISTINCT img.id) as total_imagens,
           STRING_AGG(DISTINCT is2.setor, ', ') as setores
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    LEFT JOIN itens_setores is2 ON i.id = is2.item_id
    ${whereClause}
    GROUP BY i.id
    ${orderByClause}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;
  
  // Adicionar parâmetros de paginação
  params.push(limit, offset);

  // Primeiro, contar o total de itens
  pool.query(countQuery, params.slice(0, paramIndex - 1), (err, countResult) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const total = parseInt(countResult.rows[0].total);
    
    // Depois, buscar os itens com paginação
    pool.query(query, params, (err, result) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      const itens = result.rows.map(row => ({
        ...row,
        imagens: row.imagens ? row.imagens.split(',') : []
      }));
      res.json({ 
        itens, 
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        searchTerm
      });
    });
  });
});

// Rota de proxy para imagens do Cloudflare R2
app.get('/api/imagem/:filename(*)', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  
  console.log('🔧 [PROXY] Solicitando imagem:', filename);
  
  // Verificar se as credenciais estão configuradas
  // Configurar o cliente S3 para R2
  const s3Client = createS3Client();
  
  if (!s3Client) {
    return res.status(503).json({ 
      error: 'Serviço de armazenamento não configurado',
      message: 'Configure as variáveis de ambiente R2_ENDPOINT, R2_ACCESS_KEY e R2_SECRET_KEY'
    });
  }
  
  const params = {
    Bucket: process.env.R2_BUCKET || 'catalogo-imagens',
    Key: filename
  };
  
  s3Client.getObject(params, (err, data) => {
    if (err) {
      console.error('❌ [PROXY] Erro ao buscar imagem do R2:', err);
      return res.status(404).json({ 
        error: 'Imagem não encontrada',
        details: err.message 
      });
    }
    
    // Determinar o tipo de conteúdo
    const contentType = data.ContentType || 'image/jpeg';
    
    console.log('✅ [PROXY] Imagem encontrada:', filename);
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Length', data.ContentLength);
    
    res.send(data.Body);
  });
});

// Buscar item por ID
app.get('/api/itens/:id', (req, res) => {
  const itemId = req.params.id;
  // Buscar item, incluindo setores agregados
  pool.query(`
    SELECT i.*, COALESCE(STRING_AGG(DISTINCT is2.setor, ', '), '') AS setores
    FROM itens i
    LEFT JOIN itens_setores is2 ON is2.item_id = i.id
    WHERE i.id = $1
    GROUP BY i.id
  `, [itemId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    // Processar setores - converter string para array
    const item = result.rows[0];
    let setores = [];
    if (item.setores && item.setores.trim() !== '') {
      setores = item.setores.split(', ').filter(s => s.trim() !== '');
    }
    item.setores = setores;
    // Buscar imagens (normais e de itens compostos)
    pool.query('SELECT * FROM imagens_itens WHERE item_id = $1 ORDER BY is_completo ASC', [itemId], (err, imagensResult) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      // Buscar armazéns
      pool.query('SELECT armazem, quantidade FROM armazens_item WHERE item_id = $1', [itemId], (err, armazensResult) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        // Detecção automática COMPLETAMENTE DESABILITADA para evitar duplicação
        const codigo = result.rows[0].codigo;
        console.log(`🔒 Detecção automática DESABILITADA para item ${codigo}. Imagens existentes: ${imagensResult.rows.length}`);
        if (imagensResult.rows.length > 0) {
          console.log('📋 Imagens existentes no banco:');
          imagensResult.rows.forEach((img, index) => {
            console.log(`   ${index + 1}. ID: ${img.id}, Nome: ${img.nome_arquivo}, Caminho: ${img.caminho}`);
          });
        }
        const imagensProcessadas = imagensResult.rows.map(img => {
          let caminhoFinal;
          if (img.caminho.startsWith('/api/imagem/')) {
            caminhoFinal = img.caminho;
          } else if (img.caminho.startsWith('http')) {
            if (img.caminho.includes('r2.cloudflarestorage.com')) {
              const urlParts = img.caminho.split('/');
              const filename = decodeURIComponent(urlParts[urlParts.length - 1]);
              caminhoFinal = `/api/imagem/${encodeURIComponent(filename)}`;
            } else {
              caminhoFinal = img.caminho;
            }
          } else {
            caminhoFinal = `/api/imagem/${encodeURIComponent(img.caminho)}`;
          }
          console.log('Processando imagem:', {
            id: img.id,
            caminhoOriginal: img.caminho,
            caminhoFinal: caminhoFinal,
            nome_arquivo: img.nome_arquivo,
            is_completo: img.is_completo
          });
          return {
            id: img.id,
            caminho: caminhoFinal,
            nome_arquivo: img.nome_arquivo,
            tipo: img.tipo,
            is_completo: img.is_completo || false
          };
        });

        // Separar imagens normais das imagens de itens compostos
        const imagensNormais = imagensProcessadas.filter(img => !img.is_completo);
        const imagensCompostas = imagensProcessadas.filter(img => img.is_completo);
        // Buscar componentes do item
        pool.query(`
          SELECT 
            ic.id,
            ic.quantidade_componente,
            i.id as item_id,
            i.codigo,
            i.descricao,
            i.unidadearmazenamento
          FROM itens_compostos ic
          JOIN itens i ON ic.item_componente_id = i.id
          WHERE ic.item_principal_id = $1
          ORDER BY i.codigo
        `, [itemId], (err, componentesResult) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          res.json({
            ...result.rows[0],
            imagens: imagensNormais,
            imagensCompostas: imagensCompostas,
            armazens: armazensResult.rows || [],
            componentes: componentesResult.rows
          });
        });
      });
    });
  });
});

// Cadastrar novo item (protegido)
app.post('/api/itens', authenticateToken, upload.fields([
  { name: 'imagens', maxCount: 10 },
  { name: 'imagemCompleta', maxCount: 1 }
]), async (req, res) => {
  const {
    nome,
    descricao,
    categoria,
    codigo,
    preco,
    quantidade,
    localizacao,
    observacoes
  } = req.body;

  // Validações obrigatórias
  if (!codigo || !descricao) {
    return res.status(400).json({ error: 'Código e descrição são obrigatórios' });
  }

  // Verificar se código já existe
  if (codigo) {
    try {
      const result = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
      if (result.rows.length > 0) {
        return res.status(400).json({ error: 'Código já existe' });
      }
      await inserirItem();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    await inserirItem();
  }

  async function inserirItem() {
    // Concatenar peso e unidadePeso se ambos existirem
    let pesoFinal = '';
    if (req.body.peso && req.body.unidadepeso) {
      pesoFinal = `${req.body.peso} ${req.body.unidadepeso}`;
    } else if (req.body.peso) {
      pesoFinal = req.body.peso;
    }
    const itemData = {
      nome: nome || descricao, // Se nome não for enviado, usar descricao como nome
      descricao,
      categoria: categoria || 'Sem categoria', // valor padrão
      codigo,
      preco: preco ? parseFloat(preco) : null,
      quantidade: quantidade ? parseInt(quantidade) : 0,
      localizacao,
      observacoes,
      familia: req.body.familia || '',
      subfamilia: req.body.subfamilia || '',
      setor: req.body.setor || '',
      comprimento: req.body.comprimento ? parseFloat(req.body.comprimento) : null,
      largura: req.body.largura ? parseFloat(req.body.largura) : null,
      altura: req.body.altura ? parseFloat(req.body.altura) : null,
      unidade: req.body.unidade || '',
      peso: pesoFinal,
      unidadepeso: req.body.unidadepeso || '',
      unidadearmazenamento: req.body.unidadeArmazenamento || '',
      tipocontrolo: req.body.tipocontrolo || '',
      ativo: true // Sempre ativo ao cadastrar
    };

    // Logar o corpo da requisição para depuração
    console.log('Dados recebidos no cadastro de item:', req.body);

    try {
      const result = await pool.query(`
        INSERT INTO itens (nome, descricao, categoria, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, comprimento, largura, altura, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id
      `, [itemData.nome, itemData.descricao, itemData.categoria, itemData.codigo, itemData.preco, itemData.quantidade, itemData.localizacao, itemData.observacoes,
          itemData.familia, itemData.subfamilia, itemData.comprimento, itemData.largura, itemData.altura, itemData.unidade, itemData.peso, itemData.unidadepeso, itemData.unidadearmazenamento, itemData.tipocontrolo, itemData.ativo]);

      const itemId = result.rows[0].id;

      // Inserir setores múltiplos
      if (req.body.setores) {
        try {
          const setores = JSON.parse(req.body.setores);
          if (Array.isArray(setores) && setores.length > 0) {
            for (const setor of setores) {
              await pool.query(
                'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
                [itemId, setor]
              );
            }
            console.log(`✅ Setores inseridos para item ${itemId}:`, setores);
          }
        } catch (setoresError) {
          console.error(`❌ Erro ao inserir setores: ${setoresError.message}`);
        }
      }

      // Remover item da tabela de itens não cadastrados se existir
      try {
        const deleteResult = await pool.query('DELETE FROM itens_nao_cadastrados WHERE codigo = $1', [codigo]);
        if (deleteResult.rowCount > 0) {
          console.log(`🗑️  Item removido da tabela de não cadastrados: ${codigo}`);
        }
      } catch (deleteError) {
        console.error(`❌ Erro ao remover item da tabela de não cadastrados: ${deleteError.message}`);
      }

      // Salvar imagens no AWS S3
      console.log('🔄 === INÍCIO DO UPLOAD DE IMAGENS (CADASTRO) ===');
      console.log('req.files:', req.files);
      console.log('Arquivos para upload no cadastro:', req.files ? Object.keys(req.files).length : 0);
      
      // Verificar se req.files existe antes de processar
      if (!req.files) {
        console.log('ℹ️  Nenhum arquivo enviado no cadastro');
        console.log('🔄 === FIM DO UPLOAD DE IMAGENS (CADASTRO) ===');
        
        res.status(201).json({ 
          message: 'Item cadastrado com sucesso',
          itemId: itemId 
        });
        return;
      }
      
      // Processar imagens normais
      const imagensNormais = req.files && req.files.imagens ? req.files.imagens : [];
      
      // Verificar se há imagens para processar
      if (imagensNormais.length > 0) {
        imagensNormais.forEach((file, index) => {
          console.log(`   ${index + 1}. ${file.originalname} (${file.mimetype})`);
          });
          
          const imagensPromises = imagensNormais.map(async (file) => {
            try {
              // Buscar o código do item para usar no nome do arquivo
              const codigoResult = await pool.query('SELECT codigo FROM itens WHERE id = $1', [itemId]);
              const codigo = codigoResult.rows[0]?.codigo || itemId;
              
              // Upload para AWS S3 com nome baseado no código
              console.log(`📤 Upload para R2: ${file.originalname}`);
              const s3Result = await uploadToS3(
                file.path,
                `${codigo}_${Date.now()}_${file.originalname}`,
                file.mimetype
              );
              console.log(`✅ Upload concluído: ${s3Result.url}`);
              
              // Salvar informações no banco
              console.log(`💾 Salvando imagem no banco (cadastro): ${file.originalname}`);
              return new Promise((resolve, reject) => {
                pool.query(
                  `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo)
                   VALUES ($1, $2, $3, $4) RETURNING id`,
                  [itemId, file.originalname, s3Result.url, file.mimetype],
                  (err, result) => {
                    if (err) reject(err);
                    else {
                      console.log(`✅ Imagem salva no banco com ID: ${result.rows[0].id}`);
                      // Remover arquivo local após upload
                      fs.unlink(file.path, (unlinkErr) => {
                        if (unlinkErr) {
                          console.error('Erro ao remover arquivo local:', unlinkErr);
                        } else {
                          console.log(`🗑️  Arquivo local removido: ${file.path}`);
                        }
                      });
                      resolve();
                    }
                  }
                );
              });
            } catch (error) {
              console.error('Erro no upload para AWS S3:', error);
              throw error;
            }
          });

          Promise.all(imagensPromises).then(async () => {
            // Verificar total de imagens após upload
            const totalImagens = await pool.query('SELECT COUNT(*) as total FROM imagens_itens WHERE item_id = $1', [itemId]);
            console.log(`📊 Total de imagens no item ${itemId} após cadastro: ${totalImagens.rows[0].total}`);
            console.log('🔄 === FIM DO UPLOAD DE IMAGENS (CADASTRO) ===');
            
            // Processar imagem do item completo se existir
            if (req.files && req.files.imagemCompleta && Array.isArray(req.files.imagemCompleta) && req.files.imagemCompleta.length > 0) {
              const imagemCompleta = req.files.imagemCompleta[0];
              try {
                console.log(`📤 Upload da imagem do item completo: ${imagemCompleta.originalname}`);
                const s3Result = await uploadToS3(
                  imagemCompleta.path,
                  `IC_${codigo}_${Date.now()}_${imagemCompleta.originalname}`,
                  imagemCompleta.mimetype
                );
                console.log(`✅ Upload da imagem completa concluído: ${s3Result.url}`);
                
                // Salvar no banco com flag especial
                await pool.query(
                  `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [itemId, imagemCompleta.originalname, s3Result.url, imagemCompleta.mimetype, true]
                );
                
                // Remover arquivo local
                fs.unlink(imagemCompleta.path, (err) => {
                  if (err) console.error('Erro ao remover arquivo local da imagem completa:', err);
                });
              } catch (error) {
                console.error('Erro no upload da imagem completa:', error);
              }
            }
            
            res.status(201).json({ 
              message: 'Item cadastrado com sucesso',
              itemId: itemId 
            });
          }).catch(err => {
            res.status(500).json({ error: err.message });
          });
        } else {
          console.log('ℹ️  Nenhuma imagem enviada no cadastro');
          console.log('🔄 === FIM DO UPLOAD DE IMAGENS (CADASTRO) ===');
          
          res.status(201).json({ 
            message: 'Item cadastrado com sucesso',
            itemId: itemId 
          });
        }
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
  }
);

// Buscar itens por imagem (reconhecimento) - PÚBLICO
app.post('/api/reconhecer', upload.single('imagem'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  }

  // Função para calcular cor média de uma imagem
  async function getAverageColorFromFile(filePath) {
    try {
      const { data, info } = await sharp(filePath).resize(32, 32).raw().toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
      }
      const pixels = data.length / info.channels;
      return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
    } catch (err) {
      return [0, 0, 0];
    }
  }

  // Calcular cor média da imagem enviada
  const corMediaEnviada = await getAverageColorFromFile(req.file.path);

  // Buscar itens e imagens do banco
  pool.query(`
    SELECT i.*, img.id as img_id, img.caminho as img_caminho
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
  `, async (err, result) => {
    if (err) {
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: err.message });
    }
    // Para cada imagem, calcular cor média
    const itensMap = {};
    const corMediaBanco = [];
    for (const row of result.rows) {
      if (!row.img_caminho) continue;
      try {
        // Baixar imagem do Google Drive se for URL
        let localPath = row.img_caminho;
        if (row.img_caminho.startsWith('http')) {
          // Baixar temporariamente
          const axios = require('axios');
          const tempPath = `uploads/temp_${row.img_id}_${Date.now()}.jpg`;
          const response = await axios({ url: row.img_caminho, responseType: 'arraybuffer' });
          fs.writeFileSync(tempPath, response.data);
          localPath = tempPath;
        }
        const cor = await getAverageColorFromFile(localPath);
        corMediaBanco.push({ itemId: row.id, imgId: row.img_id, caminho: row.img_caminho, cor });
        if (localPath !== row.img_caminho && fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch {}
    }
    // Calcular distância de cor
    function colorDistance(c1, c2) {
      return Math.sqrt((c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2);
    }
    // Para cada item, pegar a menor distância de cor entre as imagens
    const itemScores = {};
    for (const img of corMediaBanco) {
      const dist = colorDistance(corMediaEnviada, img.cor);
      if (!itemScores[img.itemId] || dist < itemScores[img.itemId].dist) {
        itemScores[img.itemId] = { dist, caminho: img.caminho };
      }
    }
    // Buscar dados dos itens mais próximos
    const topItens = Object.entries(itemScores)
      .sort((a, b) => a[1].dist - b[1].dist)
      .slice(0, 10)
      .map(([itemId, data]) => ({ itemId: Number(itemId), distancia: data.dist, imagem: data.caminho }));
    // Buscar detalhes dos itens
    const ids = topItens.map(i => i.itemId);
    if (ids.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.json({ resultados: [], analise: { corMediaEnviada } });
    }
    pool.query(`SELECT * FROM itens WHERE id = ANY($1)`, [ids], (err2, itensResult) => {
      fs.unlinkSync(req.file.path);
      if (err2) return res.status(500).json({ error: err2.message });
      // Juntar info
      const itensDetalhados = topItens.map(ti => {
        const item = itensResult.rows.find(i => i.id === ti.itemId);
        return { ...item, distancia: ti.distancia, imagemMaisProxima: ti.imagem };
      });
      res.json({ resultados: itensDetalhados, analise: { corMediaEnviada } });
    });
  });
});

// Buscar itens por texto
app.get('/api/buscar', (req, res) => {
  const { q } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'Termo de busca é obrigatório' });
  }

  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    WHERE i.nome LIKE $1 OR i.descricao LIKE $2 OR i.categoria LIKE $3
    GROUP BY i.id
    ORDER BY i.data_cadastro DESC
  `;

  const searchTerm = `%${q}%`;
  
  pool.query(query, [searchTerm, searchTerm, searchTerm], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const itens = result.rows.map(row => ({
      ...row,
      imagens: row.imagens ? row.imagens.split(',') : []
    }));
    
    res.json(itens);
  });
});

// Atualizar item (protegido)
app.put('/api/itens/:id', authenticateToken, upload.fields([
  { name: 'imagens', maxCount: 10 },
  { name: 'imagemCompleta', maxCount: 1 }
]), (req, res) => {
  // Logar o corpo da requisição para depuração
  console.log('Dados recebidos na edição de item:', req.body);
  // Verificar permissão para editar
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem editar itens.' });
  }
  const itemId = req.params.id;
  const {
    nome,
    descricao,
    categoria,
    codigo,
    preco,
    quantidade,
    localizacao,
    observacoes,
    familia,
    subfamilia,
    setor,
    comprimento,
    largura,
    altura,
    unidade,
    peso,
    unidadepeso,
    unidadearmazenamento,
    tipocontrolo,
    especificacoes
  } = req.body;

  if (!codigo || !descricao) {
    return res.status(400).json({ error: 'Código e descrição são obrigatórios' });
  }

  // Tratar campos numéricos - converter strings vazias para null
  const precoNum = preco && preco.trim() !== '' ? parseFloat(preco) : null;
  const quantidadeNum = quantidade && quantidade.trim() !== '' ? parseInt(quantidade) : null;
  const comprimentoNum = comprimento && comprimento.trim() !== '' ? parseFloat(comprimento) : null;
  const larguraNum = largura && largura.trim() !== '' ? parseFloat(largura) : null;
  const alturaNum = altura && altura.trim() !== '' ? parseFloat(altura) : null;

  pool.query(`
    UPDATE itens 
    SET nome = $1, descricao = $2, categoria = $3, codigo = $4, preco = $5, quantidade = $6, localizacao = $7, observacoes = $8,
        familia = $9, subfamilia = $10, comprimento = $11, largura = $12, altura = $13,
        unidade = $14, peso = $15, unidadepeso = $16, unidadearmazenamento = $17, tipocontrolo = $18
    WHERE id = $19
  `, [
    nome || descricao, descricao, categoria || 'Sem categoria', codigo, precoNum, quantidadeNum, localizacao, observacoes,
    familia, subfamilia, comprimentoNum, larguraNum, alturaNum, unidade, peso, unidadepeso, unidadearmazenamento, tipocontrolo, itemId
  ], async (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    // Atualizar setores múltiplos
    if (req.body.setores) {
      try {
        // Remover setores existentes
        await pool.query('DELETE FROM itens_setores WHERE item_id = $1', [itemId]);
        
        // Inserir novos setores
        const setores = JSON.parse(req.body.setores);
        if (Array.isArray(setores) && setores.length > 0) {
          for (const setor of setores) {
            await pool.query(
              'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
              [itemId, setor]
            );
          }
          console.log(`✅ Setores atualizados para item ${itemId}:`, setores);
        }
      } catch (setoresError) {
        console.error(`❌ Erro ao atualizar setores: ${setoresError.message}`);
      }
    }

        // Remover imagens marcadas para exclusão
    if (req.body.imagensRemovidas) {
      try {
        const imagensRemovidas = JSON.parse(req.body.imagensRemovidas);
        for (const imgId of imagensRemovidas) {
          // Buscar caminho da imagem
          const { rows } = await pool.query('SELECT caminho, nome_arquivo FROM imagens_itens WHERE id = $1 AND item_id = $2', [imgId, itemId]);
          if (rows.length > 0) {
            let key = rows[0].caminho;
            // Se for URL do proxy, extrair o nome do arquivo
            if (key.startsWith('/api/imagem/')) {
              key = decodeURIComponent(key.replace('/api/imagem/', ''));
            } else if (key.startsWith('http')) {
              // Se for URL completa do R2, extrair apenas o nome do arquivo
              const urlParts = key.split('/');
              key = decodeURIComponent(urlParts[urlParts.length - 1]);
            } else {
              // Se for apenas o nome do arquivo
              key = rows[0].nome_arquivo || key;
            }
            console.log('Tentando deletar imagem do R2:', key);
            await deleteFromS3(key);
            await pool.query('DELETE FROM imagens_itens WHERE id = $1', [imgId]);
          }
        }
      } catch (err) {
        return res.status(500).json({ error: 'Erro ao remover imagens: ' + err.message });
      }
    }

    // Salvar novas imagens, se enviadas
    console.log('🔄 === INÍCIO DO UPLOAD DE IMAGENS ===');
    console.log('req.files:', req.files);
    console.log('req.file:', req.file);

    console.log('req.body.imagensRemovidas:', req.body.imagensRemovidas);
    
    // Verificar se req.files existe antes de processar
    if (!req.files) {
      console.log('ℹ️  Nenhum arquivo enviado na edição');
      console.log('🔄 === FIM DO UPLOAD DE IMAGENS ===');
      
      res.json({ message: 'Item atualizado com sucesso' });
      return;
    }
    
    // Processar imagens normais
    const imagensNormais = req.files && req.files.imagens ? req.files.imagens : [];
    const imagemCompleta = req.files && req.files.imagemCompleta && Array.isArray(req.files.imagemCompleta) && req.files.imagemCompleta.length > 0 ? req.files.imagemCompleta[0] : null;
    
    console.log('📁 Imagens normais para upload:', imagensNormais.length);
    imagensNormais.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file.originalname} (${file.mimetype})`);
    });
    
    if (imagemCompleta) {
      console.log('📁 Imagem completa para upload:', imagemCompleta.originalname);
    }
    
    if (imagensNormais.length > 0 || imagemCompleta) {
              try {
          // Processar imagens normais
          if (imagensNormais.length > 0) {
            const imagensPromises = imagensNormais.map(async (file) => {
              // Buscar o código do item para usar no nome do arquivo
              const codigoResult = await pool.query('SELECT codigo FROM itens WHERE id = $1', [itemId]);
              const codigo = codigoResult.rows[0]?.codigo || itemId;
              
              // Upload para AWS S3 com nome baseado no código
              const s3Result = await uploadToS3(
                file.path,
                `${codigo}_${Date.now()}_${file.originalname}`,
                file.mimetype
              );
              // Salvar informações no banco
              console.log(`💾 Salvando imagem normal no banco: ${file.originalname}`);
              const insertResult = await pool.query(
                `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [itemId, file.originalname, s3Result.url, file.mimetype, false]
              );
              console.log(`✅ Imagem normal salva no banco com ID: ${insertResult.rows[0].id}`);
              
              // Remover arquivo local após upload
              fs.unlink(file.path, (unlinkErr) => {
                if (unlinkErr) {
                  console.error('Erro ao remover arquivo local:', unlinkErr);
                } else {
                  console.log(`🗑️  Arquivo local removido: ${file.path}`);
                }
              });
            });
            await Promise.all(imagensPromises);
          }
          
          // Processar imagem completa se existir
          if (imagemCompleta) {
            const codigoResult = await pool.query('SELECT codigo FROM itens WHERE id = $1', [itemId]);
            const codigo = codigoResult.rows[0]?.codigo || itemId;
            
            // Upload para AWS S3 com nome baseado no código
            const s3Result = await uploadToS3(
              imagemCompleta.path,
              `IC_${codigo}_${Date.now()}_${imagemCompleta.originalname}`,
              imagemCompleta.mimetype
            );
            // Salvar informações no banco
            console.log(`💾 Salvando imagem completa no banco: ${imagemCompleta.originalname}`);
            const insertResult = await pool.query(
              `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [itemId, imagemCompleta.originalname, s3Result.url, imagemCompleta.mimetype, true]
            );
            console.log(`✅ Imagem completa salva no banco com ID: ${insertResult.rows[0].id}`);
            
            // Remover arquivo local após upload
            fs.unlink(imagemCompleta.path, (unlinkErr) => {
              if (unlinkErr) {
                console.error('Erro ao remover arquivo local:', unlinkErr);
              } else {
                console.log(`🗑️  Arquivo local removido: ${imagemCompleta.path}`);
              }
            });
          }
        
        // Verificar total de imagens após upload
        const totalImagens = await pool.query('SELECT COUNT(*) as total FROM imagens_itens WHERE item_id = $1', [itemId]);
        console.log(`📊 Total de imagens no item ${itemId} após upload: ${totalImagens.rows[0].total}`);
        console.log('🔄 === FIM DO UPLOAD DE IMAGENS ===');
      } catch (err) {
        console.error('Erro ao salvar imagens:', err);
        return res.status(500).json({ error: 'Erro ao salvar imagens: ' + err.message });
      }
    }

    res.json({ message: 'Item atualizado com sucesso' });
  });
});

// Função para deletar imagem do S3
async function deleteFromS3(key) {
  console.log('🔧 [DELETE] Iniciando deleteFromS3 com key:', key);
  
  // Valores padrão para desenvolvimento local
  const bucket = process.env.R2_BUCKET || 'catalogo-imagens';
  const endpoint = process.env.R2_ENDPOINT || 'https://d18863b1a98e7a9ca8875305179ad718.r2.cloudflarestorage.com';
  const accessKeyId = process.env.R2_ACCESS_KEY || '32f0b3b31955b3878e1c2c107ef33fd5';
  const secretAccessKey = process.env.R2_SECRET_KEY || '580539e25b1580ce1c37425fb3eeb45be831ec029b352f6375614399e7ab714f';
  
  console.log('🔧 [DELETE] Usando bucket:', bucket);
  console.log('🔧 [DELETE] Usando endpoint:', endpoint);
  
  // Verificar se as credenciais estão configuradas
  if (!accessKeyId || !secretAccessKey || accessKeyId === '32f0b3b31955b3878e1c2c107ef33fd5') {
    console.log('⚠️ [DELETE] Credenciais R2 não configuradas, pulando exclusão de imagem');
    return Promise.resolve();
  }
  
  const s3 = new AWS.S3({
    endpoint: endpoint,
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
    signatureVersion: 'v4',
    region: 'auto', // Voltando para 'auto' para Cloudflare R2
    s3ForcePathStyle: true,
    maxRetries: 3,
    httpOptions: {
      timeout: 30000,
      agent: new https.Agent({
        keepAlive: true,
        maxSockets: 50,
        rejectUnauthorized: false
      })
    }
  });
  
  return new Promise((resolve, reject) => {
    s3.deleteObject({
      Bucket: bucket,
      Key: key
    }, (err, data) => {
      if (err) {
        console.error('❌ [DELETE] Erro ao deletar do R2:', err);
        // Não rejeitar o erro, apenas logar
        console.log('⚠️ [DELETE] Continuando sem deletar imagem do R2');
        resolve();
      } else {
        console.log('✅ [DELETE] Imagem deletada do R2 com sucesso:', key);
        resolve(data);
      }
    });
  });
}

// Excluir item e imagens do S3
app.delete('/api/itens/:id', authenticateToken, async (req, res) => {
  const itemId = req.params.id;
  const userRole = req.user && req.user.role;
  if (userRole !== 'admin' && userRole !== 'controller') {
    return res.status(403).json({ error: 'Acesso restrito a administradores ou controllers.' });
  }
  try {
    // Buscar imagens associadas
    const { rows: imagens } = await pool.query('SELECT caminho FROM imagens_itens WHERE item_id = $1', [itemId]);
    // Excluir imagens do S3
    for (const img of imagens) {
      let key = img.caminho;
      // Se for URL completa, extrair apenas o nome do arquivo
      if (key.startsWith('http')) {
        const url = new URL(key);
        key = decodeURIComponent(url.pathname.replace(/^\//, ''));
      }
      await deleteFromS3(key);
    }
    // Excluir registros do banco
    await pool.query('DELETE FROM imagens_itens WHERE item_id = $1', [itemId]);

    await pool.query('DELETE FROM armazens_item WHERE item_id = $1', [itemId]);
    const { rowCount } = await pool.query('DELETE FROM itens WHERE id = $1', [itemId]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    res.json({ message: 'Item e imagens excluídos com sucesso.' });
  } catch (error) {
    console.error('Erro ao excluir item/imagens:', error);
    res.status(500).json({ error: 'Erro ao excluir item ou imagens.' });
  }
});

// Deletar TODOS os itens (protegido, apenas admin)
app.delete('/api/itens', authenticateToken, (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem excluir todos os itens.' });
  }
  pool.query('BEGIN TRANSACTION', (err) => {
    if (err) {
      console.error('Erro ao iniciar transação para deletar todos os itens:', err.message);
      return res.status(500).json({ error: 'Erro ao iniciar transação.' });
    }
    pool.query('DELETE FROM armazens_item', [], (err) => {
      if (err) {
        console.error('Erro ao apagar armazéns:', err.message);
        return res.status(500).json({ error: 'Erro ao apagar armazéns.' });
      }
      pool.query('DELETE FROM imagens_itens', [], (err2) => {
        if (err2) {
          console.error('Erro ao apagar imagens:', err2.message);
          return res.status(500).json({ error: 'Erro ao apagar imagens.' });
        }
        pool.query('DELETE FROM itens', [], (err4) => {
          if (err4) {
            console.error('Erro ao apagar itens:', err4.message);
            return res.status(500).json({ error: 'Erro ao apagar itens.' });
          }
          res.json({ message: 'Todos os itens foram excluídos com sucesso.' });
        });
      });
    });
  });
});

// Deletar imagem específica (protegido)
app.delete('/api/imagens/:id', authenticateToken, (req, res) => {
  const imagemId = req.params.id;

  pool.query('SELECT caminho FROM imagens_itens WHERE id = $1', [imagemId], (err, imagemResult) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    if (imagemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }

    // Deletar arquivo físico
    const filePath = path.join(__dirname, '..', 'uploads', imagemResult.rows[0].caminho);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Deletar do banco
    pool.query('DELETE FROM imagens_itens WHERE id = $1', [imagemId], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({ message: 'Imagem deletada com sucesso' });
    });
  });
});

// Obter categorias
app.get('/api/categorias', (req, res) => {
  pool.query('SELECT DISTINCT categoria FROM itens ORDER BY categoria', [], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const categorias = result.rows.map(row => row.categoria);
    res.json(categorias);
  });
});

// Estatísticas
app.get('/api/estatisticas', (req, res) => {
  const stats = {};
  
  // Total de itens
  pool.query('SELECT COUNT(*) as total FROM itens', [], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    stats.totalItens = result.rows[0].total;
    
    // Total de categorias
    pool.query('SELECT COUNT(DISTINCT categoria) as total FROM itens', [], (err, result) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      stats.totalCategorias = result.rows[0].total;
      
      // Total de imagens
      pool.query('SELECT COUNT(*) as total FROM imagens_itens', [], (err, result) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        stats.totalImagens = result.rows[0].total;
        
        res.json(stats);
      });
    });
  });
});

// Endpoint de teste para upload de imagem
app.post('/api/test-upload', upload.single('imagem'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  }

  try {
    console.log('Iniciando teste de upload para Google Drive...');
    console.log('Arquivo:', req.file.originalname);
    console.log('Tamanho:', req.file.size);
    console.log('Tipo:', req.file.mimetype);

    // Upload para Google Drive
    const driveResult = await uploadToS3(
      req.file.path,
      `test_${Date.now()}_${req.file.originalname}`,
      req.file.mimetype
    );

    console.log('Upload bem-sucedido:', driveResult);

    // Remover arquivo local
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Erro ao remover arquivo local:', err);
    });

    res.json({
      message: 'Teste de upload bem-sucedido!',
      fileId: driveResult.url, // Assuming the S3 URL is the fileId for this test
      publicUrl: driveResult.url,
      webViewLink: null // No direct webViewLink for S3 URL
    });

  } catch (error) {
    console.error('Erro no teste de upload:', error);
    res.status(500).json({ 
      error: 'Erro no teste de upload',
      details: error.message 
    });
  }
});

// Limpar banco de dados (exceto usuários)
app.post('/api/limpar-banco', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem limpar o banco.' });
  }
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM armazens_item');
    await pool.query('DELETE FROM imagens_itens');
    await pool.query('DELETE FROM especificacoes');
    await pool.query('DELETE FROM itens');
    await pool.query('COMMIT');
    res.status(200).json({ message: 'Banco limpo com sucesso. Usuários mantidos.' });
  } catch (error) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao limpar banco.', details: error.message });
  }
});

// Exportar todos os dados do banco em JSON
app.get('/api/exportar-json', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem exportar os dados.' });
  }
  try {
    const [itens, imagens, especificacoes, armazens, usuarios] = await Promise.all([
      pool.query('SELECT * FROM itens'),
      pool.query('SELECT * FROM imagens_itens'),
      pool.query('SELECT * FROM especificacoes'),
      pool.query('SELECT * FROM armazens_item'),
      pool.query('SELECT id, username, nome, email, role, data_criacao FROM usuarios')
    ]);
    res.json({
      itens: itens.rows,
      imagens_itens: imagens.rows,
      especificacoes: especificacoes.rows,
      armazens_item: armazens.rows,
      usuarios: usuarios.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao exportar dados.', details: error.message });
  }
});

// Endpoint para exportar itens em Excel
app.get('/api/exportar-itens', authenticateToken, async (req, res) => {
  try {
    const { rows: itens } = await pool.query(`
      SELECT 
        i.codigo, 
        i.descricao, 
        i.unidadearmazenamento, 
        i.familia, 
        i.subfamilia, 
        i.ativo, 
        i.quantidade,
        STRING_AGG(DISTINCT is2.setor, ', ') as setores
      FROM itens i
      LEFT JOIN itens_setores is2 ON i.id = is2.item_id
      GROUP BY i.id, i.codigo, i.descricao, i.unidadearmazenamento, i.familia, i.subfamilia, i.ativo, i.quantidade
      ORDER BY i.codigo
    `);
    
    if (!itens.length) {
      return res.status(404).json({ error: 'Nenhum item encontrado.' });
    }
    
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Itens');
    
    // Definir cabeçalhos
    worksheet.columns = [
      { header: 'Código', key: 'codigo', width: 12 }, // Artigo
      { header: 'Descrição', key: 'descricao', width: 40 }, // Descrição
      { header: 'Unidade base', key: 'unidade_base', width: 16 }, // Unidade base
      { header: 'Família', key: 'familia', width: 18 }, // Família
      { header: 'Subfamília', key: 'subfamilia', width: 18 }, // Subfamília
      { header: 'Setores', key: 'setores', width: 25 }, // Setores (múltiplos)
      { header: 'Ativo', key: 'ativo', width: 8 }, // Ativo
      { header: 'Quantidade', key: 'quantidade', width: 12 } // Quantidade
    ];
    
    // Adicionar dados
    itens.forEach(item => {
      worksheet.addRow({
        codigo: item.codigo,
        descricao: item.descricao,
        unidade_base: item.unidadearmazenamento,
        familia: item.familia,
        subfamilia: item.subfamilia,
        setores: item.setores || '', // Usar setores (múltiplos) ou string vazia se não houver
        ativo: item.ativo,
        quantidade: item.quantidade
      });
    });
    
    // Calcular largura automática para a coluna Descrição
    let maxDescricaoLength = 0;
    itens.forEach(item => {
      const length = item.descricao ? item.descricao.length : 0;
      if (length > maxDescricaoLength) {
        maxDescricaoLength = length;
      }
    });
    
    // Ajustar largura da coluna Descrição (mínimo 40, máximo 80)
    const descricaoWidth = Math.max(40, Math.min(80, maxDescricaoLength + 5));
    worksheet.getColumn('descricao').width = descricaoWidth;
    
    // Formatar cabeçalho
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FF000000' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Aplicar bordas a todas as células (incluindo células vazias)
    const lastRow = worksheet.rowCount;
    const lastCol = worksheet.columnCount;
    
    for (let row = 1; row <= lastRow; row++) {
      for (let col = 1; col <= lastCol; col++) {
        const cell = worksheet.getCell(row, col);
        cell.border = {
          top: { style: 'thin', color: { argb: 'FF000000' } },
          left: { style: 'thin', color: { argb: 'FF000000' } },
          bottom: { style: 'thin', color: { argb: 'FF000000' } },
          right: { style: 'thin', color: { argb: 'FF000000' } }
        };
      }
    }
    
    // Congelar primeira linha
    worksheet.views = [
      { state: 'frozen', ySplit: 1 }
    ];
    
    // Gerar buffer
    const buffer = await workbook.xlsx.writeBuffer();
    
    res.setHeader('Content-Disposition', 'attachment; filename="catalogo_itens.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao exportar itens: ' + err.message });
  }
});

// Cadastro de novo usuário (apenas admin)
app.post('/api/usuarios', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem cadastrar usuários.' });
  }
  const { username, password, nome, email, role } = req.body;
  if (!username || !password || !nome || !role) {
    return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  }
  if (!['admin', 'controller'].includes(role)) {
    return res.status(400).json({ error: 'Role inválido.' });
  }
  try {
    // Verificar se username ou email já existem
    const userExists = await pool.query('SELECT id FROM usuarios WHERE username = $1 OR email = $2', [username, email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ error: 'Username ou email já cadastrado.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO usuarios (username, password, nome, email, role) VALUES ($1, $2, $3, $4, $5)',
      [username, hashedPassword, nome, email, role]
    );
    res.status(201).json({ message: 'Usuário cadastrado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao cadastrar usuário.', details: error.message });
  }
});

// Cadastro de novo usuário
app.post('/api/cadastrar-usuario', async (req, res) => {
  const { nome, numero_colaborador, senha } = req.body;
  if (!nome || !numero_colaborador || !senha) {
    return res.status(400).json({ error: 'Nome, número de colaborador e senha são obrigatórios.' });
  }
  try {
    // Verifica se já existe
    const existe = await pool.query('SELECT id FROM usuarios WHERE numero_colaborador = $1', [numero_colaborador]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Número de colaborador já cadastrado.' });
    }
    const hash = bcrypt.hashSync(senha, 10);
    // Agora inclui username (igual ao numero_colaborador)
    await pool.query(
      'INSERT INTO usuarios (nome, numero_colaborador, username, password, role) VALUES ($1, $2, $3, $4, $5)',
      [nome, numero_colaborador, numero_colaborador, hash, 'basico']
    );
    res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar todos os usuários (apenas admin/controller)
app.get('/api/usuarios', authenticateToken, async (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem acessar esta rota.' });
  }
  try {
    const result = await pool.query('SELECT id, username, numero_colaborador, nome, role, email, data_criacao FROM usuarios ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar usuários.', details: error.message });
  }
});

// Atualizar o role de um usuário (apenas admin/controller)
app.patch('/api/usuarios/:id', authenticateToken, async (req, res) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
    return res.status(403).json({ error: 'Apenas administradores ou controllers podem acessar esta rota.' });
  }
  const { id } = req.params;
  const { role } = req.body;
  if (!role || !['admin', 'controller', 'basico'].includes(role)) {
    return res.status(400).json({ error: 'Role inválido.' });
  }
  try {
    await pool.query('UPDATE usuarios SET role = $1 WHERE id = $2', [role, id]);
    res.json({ message: 'Role atualizado com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao atualizar role.', details: error.message });
  }
});

// Gerenciar fotos de reconhecimento (apenas admin)
const fotoReconhecimentoUpload = multer({ dest: 'uploads/' });

// Upload de foto de reconhecimento
app.post('/api/fotos-reconhecimento', authenticateToken, fotoReconhecimentoUpload.single('foto'), async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem enviar fotos.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }
  try {
    const { nome, descricao } = req.body;
    // Upload para Google Drive
    const driveResult = await uploadToS3(
      req.file.path,
      `reconhecimento_${Date.now()}_${req.file.originalname}`,
      req.file.mimetype
    );
    // Salvar no banco
    await pool.query(
      'INSERT INTO fotos_reconhecimento (nome, descricao, caminho) VALUES ($1, $2, $3)',
      [nome, descricao, driveResult.url]
    );
    // Remover arquivo local
    fs.unlink(req.file.path, () => {});
    res.status(201).json({ message: 'Foto enviada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao enviar foto.', details: error.message });
  }
});

// Listar fotos de reconhecimento
app.get('/api/fotos-reconhecimento', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem listar fotos.' });
  }
  try {
    const result = await pool.query('SELECT * FROM fotos_reconhecimento ORDER BY data_upload DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar fotos.', details: error.message });
  }
});

// Deletar foto de reconhecimento
app.delete('/api/fotos-reconhecimento/:id', authenticateToken, async (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem deletar fotos.' });
  }
  const id = req.params.id;
  try {
    // Buscar caminho para possível remoção do arquivo do Google Drive (opcional)
    const result = await pool.query('SELECT caminho FROM fotos_reconhecimento WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Foto não encontrada.' });
    }
    // Opcional: deletar do Google Drive usando deleteFromGoogleDrive se salvar o fileId
    await pool.query('DELETE FROM fotos_reconhecimento WHERE id = $1', [id]);
    res.json({ message: 'Foto deletada com sucesso.' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar foto.', details: error.message });
  }
});

// Endpoint para upload e reconhecimento de imagem
app.post('/vision', upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    }
    const filePath = req.file.path;
    const visionClient = new vision.ImageAnnotatorClient();
    const [result] = await visionClient.labelDetection(filePath);
    const labels = result.labelAnnotations.map(label => label.description);
    res.json({ labels });
  } catch (error) {
    console.error('Erro no Vision:', error);
    res.status(500).json({ error: 'Erro ao processar a imagem.' });
  }
});

// Endpoint protegido para análise de imagem no S3 com Rekognition
app.post('/api/rekognition-labels', authenticateToken, async (req, res) => {
  const { key } = req.body;
  const userRole = req.user && req.user.role;
  if (!key) {
    return res.status(400).json({ error: 'O campo key é obrigatório.' });
  }
  if (userRole !== 'admin' && userRole !== 'controller') {
    return res.status(403).json({ error: 'Acesso restrito a administradores ou controllers.' });
  }
  try {
    const bucket = process.env.R2_BUCKET;
    const labels = await detectLabelsFromS3(bucket, key);
    res.json({ labels });
  } catch (error) {
    console.error('Erro no Rekognition:', error);
    res.status(500).json({ error: 'Erro ao analisar imagem no Rekognition.' });
  }
});

// Rota para importar imagens automaticamente baseadas na nomenclatura do código do item
app.post('/api/importar-imagens-automaticas', authenticateToken, async (req, res) => {
  try {
    const { codigo } = req.body;
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código do item é obrigatório' });
    }

    // Buscar o item pelo código
    const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado com este código' });
    }

    const itemId = itemResult.rows[0].id;
    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [IMPORTAÇÃO] Cliente S3 não configurado, pulando busca de imagens');
      return res.status(503).json({ 
        error: 'Serviço de armazenamento não configurado',
        message: 'Configure as variáveis de ambiente R2_ENDPOINT, R2_ACCESS_KEY e R2_SECRET_KEY'
      });
    }

    // Listar objetos no bucket que correspondem ao padrão do código
    const listParams = {
      Bucket: bucket,
      Prefix: `${codigo}_`
    };

    console.log(`🔍 [IMPORTAÇÃO] Procurando imagens no bucket com prefixo: ${codigo}_`);
    console.log(`📦 [IMPORTAÇÃO] Bucket: ${bucket}`);

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    console.log(`📊 [IMPORTAÇÃO] Total de imagens encontradas no bucket: ${imagensEncontradas.length}`);
    
    if (imagensEncontradas.length > 0) {
      console.log('📋 [IMPORTAÇÃO] Imagens encontradas:');
      imagensEncontradas.forEach((img, index) => {
        console.log(`   ${index + 1}. ${img.Key} (${img.Size} bytes)`);
      });
    }

    if (imagensEncontradas.length === 0) {
      console.log(`❌ [IMPORTAÇÃO] Nenhuma imagem encontrada com prefixo: ${codigo}_`);
      return res.status(404).json({ 
        error: 'Nenhuma imagem encontrada no bucket com o padrão de nomenclatura',
        message: `Procurando por imagens com prefixo: ${codigo}_`
      });
    }

    let imagensImportadas = 0;
    let imagensJaExistentes = 0;

    for (const objeto of imagensEncontradas) {
      const nomeArquivo = objeto.Key;
      
      console.log(`🔍 [IMPORTAÇÃO] Processando imagem: ${nomeArquivo}`);
      
      // Verificar se a imagem já está cadastrada no banco para QUALQUER item
      const existingImage = await pool.query(
        'SELECT id, item_id FROM imagens_itens WHERE nome_arquivo = $1',
        [nomeArquivo]
      );

      if (existingImage.rows.length > 0) {
        // Buscar informações do item que já possui esta imagem
        const itemExistente = await pool.query(
          'SELECT codigo, descricao FROM itens WHERE id = $1',
          [existingImage.rows[0].item_id]
        );
        
        const itemInfo = itemExistente.rows[0];
        console.log(`⚠️  [IMPORTAÇÃO] Imagem ${nomeArquivo} já está relacionada ao item ${itemInfo.codigo} (${itemInfo.descricao})`);
        imagensJaExistentes++;
        continue;
      }

      console.log(`✅ [IMPORTAÇÃO] Imagem ${nomeArquivo} não encontrada no banco, importando...`);

      // Determinar o tipo MIME baseado na extensão
      const extensao = nomeArquivo.split('.').pop().toLowerCase();
      let tipoMime = 'image/jpeg';
      if (extensao === 'png') tipoMime = 'image/png';
      else if (extensao === 'gif') tipoMime = 'image/gif';
      else if (extensao === 'webp') tipoMime = 'image/webp';

      // Construir URL do proxy para a imagem
      const urlImagem = `/api/imagem/${encodeURIComponent(nomeArquivo)}`;

      console.log(`📝 [IMPORTAÇÃO] Salvando no banco: itemId=${itemId}, nomeArquivo=${nomeArquivo}, urlImagem=${urlImagem}, tipoMime=${tipoMime}`);

      // Inserir no banco de dados
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo) VALUES ($1, $2, $3, $4)',
        [itemId, nomeArquivo, urlImagem, tipoMime]
      );

      imagensImportadas++;
      console.log(`✅ [IMPORTAÇÃO] Imagem ${nomeArquivo} importada com sucesso!`);
    }

    res.json({
      message: 'Importação concluída',
      totalEncontradas: imagensEncontradas.length,
      imagensImportadas,
      imagensJaExistentes,
      codigo,
      itemId
    });

  } catch (error) {
    console.error('Erro na importação automática:', error);
    res.status(500).json({ 
      error: 'Erro ao importar imagens automaticamente',
      details: error.message 
    });
  }
});

// Rota para listar imagens disponíveis no bucket para um código específico
app.get('/api/imagens-bucket/:codigo', authenticateToken, async (req, res) => {
  try {
    const { codigo } = req.params;
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código do item é obrigatório' });
    }

    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [LISTAGEM] Cliente S3 não configurado');
      return res.status(503).json({ 
        error: 'Serviço de armazenamento não configurado',
        message: 'Configure as variáveis de ambiente R2_ENDPOINT, R2_ACCESS_KEY e R2_SECRET_KEY'
      });
    }

    // Listar objetos no bucket que correspondem ao padrão do código
    const listParams = {
      Bucket: bucket,
      Prefix: `${codigo}_`
    };

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    // Buscar o item para verificar se existe
    const itemResult = await pool.query('SELECT id, descricao FROM itens WHERE codigo = $1', [codigo]);
    const itemExiste = itemResult.rows.length > 0;
    const itemInfo = itemExiste ? itemResult.rows[0] : null;

    // Verificar quais imagens já estão cadastradas no banco para QUALQUER item
    const imagensResult = await pool.query(`
      SELECT ii.nome_arquivo, ii.item_id, i.codigo, i.descricao 
      FROM imagens_itens ii 
      JOIN itens i ON ii.item_id = i.id 
      WHERE ii.nome_arquivo = ANY($1)
    `, [imagensEncontradas.map(obj => obj.Key)]);

    const imagensCadastradas = {};
    imagensResult.rows.forEach(row => {
      imagensCadastradas[row.nome_arquivo] = {
        itemId: row.item_id,
        codigo: row.codigo,
        descricao: row.descricao
      };
    });

    const imagensComStatus = imagensEncontradas.map(objeto => {
      const jaCadastrada = imagensCadastradas[objeto.Key];
      return {
        nome: objeto.Key,
        tamanho: objeto.Size,
        dataModificacao: objeto.LastModified,
        jaCadastrada: !!jaCadastrada,
        itemRelacionado: jaCadastrada ? {
          codigo: jaCadastrada.codigo,
          descricao: jaCadastrada.descricao
        } : null
      };
    });

    res.json({
      codigo,
      itemExiste,
      itemInfo,
      totalImagens: imagensEncontradas.length,
      imagens: imagensComStatus
    });

  } catch (error) {
    console.error('Erro ao listar imagens do bucket:', error);
    res.status(500).json({ 
      error: 'Erro ao listar imagens do bucket',
      details: error.message 
    });
  }
});

// Função para detectar e importar imagens automaticamente
async function detectarEImportarImagensAutomaticas(itemId, codigo) {
  try {
    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [DETECÇÃO] Cliente S3 não configurado, pulando detecção de imagens');
      return { importadas: 0, jaExistentes: 0, erro: 'Serviço de armazenamento não configurado' };
    }

    // Listar objetos no bucket que correspondem ao padrão do código
    const listParams = {
      Bucket: bucket,
      Prefix: `${codigo}_`
    };

    console.log(`🔍 Procurando imagens no bucket com prefixo: ${codigo}_`);
    console.log(`📦 Bucket: ${bucket}`);

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    console.log(`📊 Total de imagens encontradas no bucket: ${imagensEncontradas.length}`);
    
    if (imagensEncontradas.length > 0) {
      console.log('📋 Imagens encontradas:');
      imagensEncontradas.forEach((img, index) => {
        console.log(`   ${index + 1}. ${img.Key} (${img.Size} bytes)`);
      });
    }

    if (imagensEncontradas.length === 0) {
      console.log(`❌ Nenhuma imagem encontrada com prefixo: ${codigo}_`);
      return { importadas: 0, jaExistentes: 0 };
    }

    let imagensImportadas = 0;
    let imagensJaExistentes = 0;

    for (const objeto of imagensEncontradas) {
      const nomeArquivo = objeto.Key;
      
      console.log(`🔍 Processando imagem: ${nomeArquivo}`);
      
      // Verificar se a imagem já está cadastrada no banco para QUALQUER item
      const existingImage = await pool.query(
        'SELECT id, item_id FROM imagens_itens WHERE nome_arquivo = $1',
        [nomeArquivo]
      );

      if (existingImage.rows.length > 0) {
        // Buscar informações do item que já possui esta imagem
        const itemExistente = await pool.query(
          'SELECT codigo, descricao FROM itens WHERE id = $1',
          [existingImage.rows[0].item_id]
        );
        
        const itemInfo = itemExistente.rows[0];
        console.log(`⚠️  Imagem ${nomeArquivo} já está relacionada ao item ${itemInfo.codigo} (${itemInfo.descricao})`);
        imagensJaExistentes++;
        continue;
      }

      console.log(`✅ Imagem ${nomeArquivo} não encontrada no banco, importando...`);

      // Determinar o tipo MIME baseado na extensão
      const extensao = nomeArquivo.split('.').pop().toLowerCase();
      let tipoMime = 'image/jpeg';
      if (extensao === 'png') tipoMime = 'image/png';
      else if (extensao === 'gif') tipoMime = 'image/gif';
      else if (extensao === 'webp') tipoMime = 'image/webp';

      // Construir URL do proxy para a imagem
      const urlImagem = `/api/imagem/${encodeURIComponent(nomeArquivo)}`;

      console.log(`📝 Salvando no banco: itemId=${itemId}, nomeArquivo=${nomeArquivo}, urlImagem=${urlImagem}, tipoMime=${tipoMime}`);

      // Inserir no banco de dados
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo) VALUES ($1, $2, $3, $4)',
        [itemId, nomeArquivo, urlImagem, tipoMime]
      );

      imagensImportadas++;
      console.log(`✅ Imagem ${nomeArquivo} importada com sucesso!`);
    }

    return { importadas: imagensImportadas, jaExistentes: imagensJaExistentes };
  } catch (error) {
    console.error('Erro na detecção automática de imagens:', error);
    return { importadas: 0, jaExistentes: 0, erro: error.message };
  }
}

// Função para detectar e importar imagens de itens compostos (IC_)
async function detectarEImportarImagensCompostas(itemId, codigo) {
  try {
    const bucket = process.env.R2_BUCKET;
    
    // Configurar cliente S3 para R2
    const s3Client = createS3Client();
    
    if (!s3Client) {
      console.log('⚠️ [DETECÇÃO] Cliente S3 não configurado, pulando detecção de imagens compostas');
      return { importadas: 0, jaExistentes: 0, erro: 'Serviço de armazenamento não configurado' };
    }

    // Listar objetos no bucket que correspondem ao padrão IC_codigo
    const listParams = {
      Bucket: bucket,
      Prefix: `IC_${codigo}_`
    };

    console.log(`🔍 [COMPOSTO] Procurando imagens no bucket com prefixo: IC_${codigo}_`);
    console.log(`📦 [COMPOSTO] Bucket: ${bucket}`);

    const listResult = await s3Client.listObjectsV2(listParams).promise();
    const imagensEncontradas = listResult.Contents || [];

    console.log(`📊 [COMPOSTO] Total de imagens encontradas no bucket: ${imagensEncontradas.length}`);
    
    if (imagensEncontradas.length > 0) {
      console.log('📋 [COMPOSTO] Imagens encontradas:');
      imagensEncontradas.forEach((img, index) => {
        console.log(`   ${index + 1}. ${img.Key} (${img.Size} bytes)`);
      });
    }

    if (imagensEncontradas.length === 0) {
      console.log(`❌ [COMPOSTO] Nenhuma imagem encontrada com prefixo: IC_${codigo}_`);
      return { importadas: 0, jaExistentes: 0 };
    }

    let imagensImportadas = 0;
    let imagensJaExistentes = 0;

    for (const objeto of imagensEncontradas) {
      const nomeArquivo = objeto.Key;
      
      console.log(`🔍 [COMPOSTO] Processando imagem: ${nomeArquivo}`);
      
      // Verificar se a imagem já está cadastrada no banco para QUALQUER item
      const existingImage = await pool.query(
        'SELECT id, item_id FROM imagens_itens WHERE nome_arquivo = $1',
        [nomeArquivo]
      );

      if (existingImage.rows.length > 0) {
        // Buscar informações do item que já possui esta imagem
        const itemExistente = await pool.query(
          'SELECT codigo, descricao FROM itens WHERE id = $1',
          [existingImage.rows[0].item_id]
        );
        
        const itemInfo = itemExistente.rows[0];
        console.log(`⚠️  [COMPOSTO] Imagem ${nomeArquivo} já está relacionada ao item ${itemInfo.codigo} (${itemInfo.descricao})`);
        imagensJaExistentes++;
        continue;
      }

      console.log(`✅ [COMPOSTO] Imagem ${nomeArquivo} não encontrada no banco, importando...`);

      // Determinar o tipo MIME baseado na extensão
      const extensao = nomeArquivo.split('.').pop().toLowerCase();
      let tipoMime = 'image/jpeg';
      if (extensao === 'png') tipoMime = 'image/png';
      else if (extensao === 'gif') tipoMime = 'image/gif';
      else if (extensao === 'webp') tipoMime = 'image/webp';

      // Construir URL do proxy para a imagem
      const urlImagem = `/api/imagem/${encodeURIComponent(nomeArquivo)}`;

      console.log(`📝 [COMPOSTO] Salvando no banco: itemId=${itemId}, nomeArquivo=${nomeArquivo}, urlImagem=${urlImagem}, tipoMime=${tipoMime}`);

      // Inserir no banco de dados com flag is_completo = true
      await pool.query(
        'INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo, is_completo) VALUES ($1, $2, $3, $4, $5)',
        [itemId, nomeArquivo, urlImagem, tipoMime, true]
      );

      imagensImportadas++;
      console.log(`✅ [COMPOSTO] Imagem ${nomeArquivo} importada com sucesso!`);
    }

    return { importadas: imagensImportadas, jaExistentes: imagensJaExistentes };
  } catch (error) {
    console.error('Erro na detecção automática de imagens compostas:', error);
    return { importadas: 0, jaExistentes: 0, erro: error.message };
  }
}

// Rota para forçar detecção automática de imagens para um item específico
app.post('/api/detectar-imagens/:itemId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    
    // Buscar o item
    const itemResult = await pool.query('SELECT id, codigo FROM itens WHERE id = $1', [itemId]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    const item = itemResult.rows[0];
    const resultado = await detectarEImportarImagensAutomaticas(item.id, item.codigo);
    
    res.json({
      message: 'Detecção automática concluída',
      itemId: item.id,
      codigo: item.codigo,
      ...resultado
    });
    
  } catch (error) {
    console.error('Erro na detecção forçada:', error);
    res.status(500).json({ 
      error: 'Erro na detecção automática',
      details: error.message 
    });
  }
});

// Rota para forçar detecção automática de imagens de itens compostos
app.post('/api/detectar-imagens-compostas/:itemId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    
    // Buscar o item
    const itemResult = await pool.query('SELECT id, codigo FROM itens WHERE id = $1', [itemId]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    const item = itemResult.rows[0];
    const resultado = await detectarEImportarImagensCompostas(item.id, item.codigo);
    
    res.json({
      message: 'Detecção automática de imagens compostas concluída',
      itemId: item.id,
      codigo: item.codigo,
      ...resultado
    });
    
  } catch (error) {
    console.error('Erro na detecção forçada de imagens compostas:', error);
    res.status(500).json({ 
      error: 'Erro na detecção automática de imagens compostas',
      details: error.message 
    });
  }
});

// ===== ROTAS PARA IMAGENS =====

// Excluir imagem
app.delete('/api/imagens/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Buscar informações da imagem
    const { rows } = await pool.query('SELECT caminho, nome_arquivo, item_id FROM imagens_itens WHERE id = $1', [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }
    
    const imagem = rows[0];
    
    // Deletar do R2
    let key = imagem.caminho;
    if (key.startsWith('/api/imagem/')) {
      key = decodeURIComponent(key.replace('/api/imagem/', ''));
    } else if (key.startsWith('http')) {
      const urlParts = key.split('/');
      key = decodeURIComponent(urlParts[urlParts.length - 1]);
    } else {
      key = imagem.nome_arquivo || key;
    }
    
    console.log('Tentando deletar imagem do R2:', key);
    await deleteFromS3(key);
    
    // Deletar do banco
    await pool.query('DELETE FROM imagens_itens WHERE id = $1', [id]);
    
    console.log(`✅ Imagem ${id} excluída com sucesso`);
    res.json({ message: 'Imagem excluída com sucesso' });
    
  } catch (error) {
    console.error('Erro ao excluir imagem:', error);
    res.status(500).json({ error: 'Erro ao excluir imagem: ' + error.message });
  }
});

// ===== ROTAS PARA ITENS COMPOSTOS =====

// Buscar itens para seleção de componentes
app.get('/api/itens-para-componentes', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, codigo, descricao, unidadearmazenamento 
      FROM itens 
      WHERE ativo = true 
      ORDER BY codigo
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar itens para componentes:', error);
    res.status(500).json({ error: 'Erro ao buscar itens' });
  }
});

// Buscar componentes de um item
app.get('/api/itens/:id/componentes', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    
    const { rows } = await pool.query(`
      SELECT 
        ic.id,
        ic.quantidade_componente,
        i.id as item_id,
        i.codigo,
        i.descricao,
        i.familia,
        i.subfamilia,
        i.setor,
        i.comprimento,
        i.largura,
        i.altura,
        i.unidade,
        i.peso,
        i.unidadepeso,
        i.tipocontrolo,
        i.observacoes,
        i.unidadearmazenamento
      FROM itens_compostos ic
      JOIN itens i ON ic.item_componente_id = i.id
      WHERE ic.item_principal_id = $1
      ORDER BY i.codigo
    `, [itemId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar componentes:', error);
    res.status(500).json({ error: 'Erro ao buscar componentes' });
  }
});

// Adicionar componente a um item
app.post('/api/itens/:id/componentes', authenticateToken, async (req, res) => {
  try {
    console.log('🔧 Adicionando componente:', req.body);
    
    const itemId = parseInt(req.params.id);
    const { item_componente_id, quantidade_componente = 1 } = req.body;
    
    console.log('📝 Dados recebidos:', { itemId, item_componente_id, quantidade_componente });
    
    if (!item_componente_id || isNaN(parseInt(item_componente_id)) || parseInt(item_componente_id) <= 0) {
      console.log('❌ ID do item componente inválido:', item_componente_id);
      return res.status(400).json({ error: 'ID do item componente é obrigatório e deve ser um número válido' });
    }
    
    const itemComponenteId = parseInt(item_componente_id);
    
    // Verificar se não está tentando adicionar o próprio item como componente
    if (itemId === itemComponenteId) {
      console.log('❌ Tentativa de adicionar item como componente de si mesmo');
      return res.status(400).json({ error: 'Um item não pode fazer parte da sua própria composição' });
    }
    
    // Verificar se os itens existem
    const itemPrincipal = await pool.query('SELECT id FROM itens WHERE id = $1', [itemId]);
    if (itemPrincipal.rows.length === 0) {
      console.log('❌ Item principal não encontrado:', itemId);
      return res.status(404).json({ error: 'Item principal não encontrado' });
    }
    
    const itemComponente = await pool.query('SELECT id FROM itens WHERE id = $1', [itemComponenteId]);
    if (itemComponente.rows.length === 0) {
      console.log('❌ Item componente não encontrado:', itemComponenteId);
      return res.status(404).json({ error: 'Item componente não encontrado' });
    }
    
    // Verificar se já existe essa relação
    const existing = await pool.query(
      'SELECT id FROM itens_compostos WHERE item_principal_id = $1 AND item_componente_id = $2',
      [itemId, itemComponenteId]
    );
    
    if (existing.rows.length > 0) {
      console.log('❌ Item já existe na composição');
      return res.status(400).json({ error: 'Este item já foi adicionado à composição' });
    }
    
    console.log('✅ Inserindo item na composição...');
    
    // Inserir item na composição
    const result = await pool.query(
      'INSERT INTO itens_compostos (item_principal_id, item_componente_id, quantidade_componente) VALUES ($1, $2, $3) RETURNING id',
      [itemId, itemComponenteId, quantidade_componente]
    );
    
    console.log('✅ Item adicionado com sucesso, ID:', result.rows[0].id);
    res.json({ message: 'Item adicionado à composição com sucesso', id: result.rows[0].id });
  } catch (error) {
    console.error('❌ Erro ao adicionar componente:', error);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({ error: 'Erro ao adicionar componente', details: error.message });
  }
});

// Remover componente de um item
app.delete('/api/itens/:id/componentes/:componenteId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    const componenteId = req.params.componenteId;
    
    const { rowCount } = await pool.query(
      'DELETE FROM itens_compostos WHERE item_principal_id = $1 AND id = $2',
      [itemId, componenteId]
    );
    
         if (rowCount === 0) {
       return res.status(404).json({ error: 'Item não encontrado na composição' });
     }
     
     res.json({ message: 'Item removido da composição com sucesso' });
  } catch (error) {
    console.error('Erro ao remover componente:', error);
    res.status(500).json({ error: 'Erro ao remover componente' });
  }
});

// Buscar itens que um item específico compõe
app.get('/api/itens/:id/compoe', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    
    const { rows } = await pool.query(`
      SELECT 
        ic.id,
        ic.quantidade_componente,
        i.id as item_principal_id,
        i.codigo,
        i.descricao,
        i.familia,
        i.subfamilia,
        i.setor,
        i.unidadearmazenamento
      FROM itens_compostos ic
      JOIN itens i ON ic.item_principal_id = i.id
      WHERE ic.item_componente_id = $1
      ORDER BY i.codigo
    `, [itemId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar itens que compõe:', error);
    res.status(500).json({ error: 'Erro ao buscar itens que compõe' });
  }
});

// Atualizar quantidade de um componente
app.put('/api/itens/:id/componentes/:componenteId', authenticateToken, async (req, res) => {
  try {
    const itemId = req.params.id;
    const componenteId = req.params.componenteId;
    const { quantidade_componente } = req.body;
    
         if (!quantidade_componente || quantidade_componente <= 0) {
       return res.status(400).json({ error: 'Quantidade necessária deve ser maior que zero' });
     }
    
    const { rowCount } = await pool.query(
      'UPDATE itens_compostos SET quantidade_componente = $1 WHERE item_principal_id = $2 AND id = $3',
      [quantidade_componente, itemId, componenteId]
    );
    
         if (rowCount === 0) {
       return res.status(404).json({ error: 'Item não encontrado na composição' });
     }
     
     res.json({ message: 'Quantidade necessária atualizada com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar quantidade:', error);
    res.status(500).json({ error: 'Erro ao atualizar quantidade' });
  }
});

// Rota para limpar imagens órfãs (imagens no banco que não existem no R2)
app.post('/api/limpar-imagens-orfas', authenticateToken, async (req, res) => {
  try {
    // Verificar se é admin
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta operação' });
    }

    // Buscar todas as imagens do banco
    const result = await pool.query('SELECT id, nome_arquivo, caminho FROM imagens ORDER BY id');
    const imagens = result.rows;
    
    let totalVerificadas = 0;
    let totalRemovidas = 0;
    const imagensRemovidas = [];

    for (const imagem of imagens) {
      totalVerificadas++;
      
      try {
        // Verificar se a imagem existe no R2
        await s3.headObject({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: imagem.nome_arquivo
        }).promise();
        
        console.log(`✅ Imagem existe no R2: ${imagem.nome_arquivo}`);
      } catch (error) {
        if (error.code === 'NoSuchKey' || error.code === 'NotFound') {
          // Imagem não existe no R2, remover do banco
          await pool.query('DELETE FROM imagens WHERE id = $1', [imagem.id]);
          totalRemovidas++;
          imagensRemovidas.push({
            id: imagem.id,
            nome: imagem.nome_arquivo,
            caminho: imagem.caminho
          });
          console.log(`🗑️  Removida imagem órfã: ${imagem.nome_arquivo}`);
        } else {
          console.error(`❌ Erro ao verificar imagem ${imagem.nome_arquivo}:`, error.message);
        }
      }
    }

    res.json({
      message: 'Limpeza de imagens órfãs concluída',
      totalVerificadas,
      totalRemovidas,
      imagensRemovidas
    });

  } catch (error) {
    console.error('Erro na limpeza de imagens órfãs:', error);
    res.status(500).json({ 
      error: 'Erro na limpeza de imagens órfãs',
      details: error.message 
    });
  }
});

// Rota para salvar itens não cadastrados
app.post('/api/itens-nao-cadastrados', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { itens } = req.body;
    
    if (!Array.isArray(itens)) {
      return res.status(400).json({ error: 'Dados inválidos.' });
    }

    // Salvar no banco de dados
    await pool.query('DELETE FROM itens_nao_cadastrados');
    
    for (const item of itens) {
      await pool.query(
        'INSERT INTO itens_nao_cadastrados (codigo, descricao, armazens, data_importacao) VALUES ($1, $2, $3, $4)',
        [item.codigo, item.descricao, JSON.stringify(item.armazens || {}), new Date()]
      );
    }

    res.json({ message: 'Itens não cadastrados salvos com sucesso', total: itens.length });
  } catch (error) {
    console.error('Erro ao salvar itens não cadastrados:', error);
    res.status(500).json({ error: 'Erro ao salvar itens não cadastrados' });
  }
});

// Rota para buscar itens não cadastrados
app.get('/api/itens-nao-cadastrados', authenticateToken, async (req, res) => {
  try {
    console.log('🔍 Buscando itens não cadastrados...');
    console.log('👤 Usuário:', req.user?.username, 'Role:', req.user?.role);
    
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      console.log('❌ Acesso negado para usuário:', req.user?.username);
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    console.log('✅ Usuário autorizado, executando query...');
    
    // Buscar itens não cadastrados que não estão na tabela de itens cadastrados
    const result = await pool.query(`
      SELECT inc.* 
      FROM itens_nao_cadastrados inc
      WHERE NOT EXISTS (
        SELECT 1 FROM itens i WHERE i.codigo = inc.codigo
      )
      ORDER BY inc.data_importacao DESC
    `);
    console.log('📊 Resultado da query:', result.rows.length, 'itens não cadastrados encontrados');
    
    const itens = result.rows.map((row, index) => {
      console.log(`📝 Processando item ${index + 1}:`, {
        codigo: row.codigo,
        descricao: row.descricao,
        armazens_type: typeof row.armazens,
        armazens_value: row.armazens
      });
      
      let armazens = {};
      try {
        if (row.armazens) {
          armazens = typeof row.armazens === 'string' ? JSON.parse(row.armazens) : row.armazens;
        }
      } catch (parseError) {
        console.error('❌ Erro ao fazer parse do armazens:', parseError);
        armazens = {};
      }
      
      return {
        id: row.id,
        codigo: row.codigo,
        descricao: row.descricao,
        armazens: armazens,
        data_importacao: row.data_importacao
      };
    });

    console.log('✅ Enviando resposta com', itens.length, 'itens');
    res.json(itens);
  } catch (error) {
    console.error('❌ Erro ao buscar itens não cadastrados:', error);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({ 
      error: 'Erro ao buscar itens não cadastrados',
      details: error.message 
    });
  }
});

// Rota para remover itens não cadastrados
app.delete('/api/itens-nao-cadastrados', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    await pool.query('DELETE FROM itens_nao_cadastrados');
    res.json({ message: 'Itens não cadastrados removidos com sucesso' });
  } catch (error) {
    console.error('Erro ao remover itens não cadastrados:', error);
    res.status(500).json({ error: 'Erro ao remover itens não cadastrados' });
  }
});

// Rota para remover um item não cadastrado específico
app.delete('/api/itens-nao-cadastrados/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    const { id } = req.params;
    
    // Verificar se o item existe
    const checkResult = await pool.query('SELECT id FROM itens_nao_cadastrados WHERE id = $1', [id]);
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    // Remover o item
    await pool.query('DELETE FROM itens_nao_cadastrados WHERE id = $1', [id]);
    
    res.json({ message: 'Item removido com sucesso' });
  } catch (error) {
    console.error('Erro ao remover item não cadastrado:', error);
    res.status(500).json({ error: 'Erro ao remover item não cadastrado' });
  }
});

// Rota para detectar imagens para todos os itens
app.post('/api/detectar-imagens-todos', authenticateToken, async (req, res) => {
  try {
    // Verificar se é admin
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta operação' });
    }
    
    // Buscar todos os itens
    const itensResult = await pool.query('SELECT id, codigo FROM itens ORDER BY codigo');
    const itens = itensResult.rows;
    
    let totalImportadas = 0;
    let totalJaExistentes = 0;
    const resultados = [];
    
    for (const item of itens) {
      const resultado = await detectarEImportarImagensAutomaticas(item.id, item.codigo);
      totalImportadas += resultado.importadas;
      totalJaExistentes += resultado.jaExistentes;
      
      if (resultado.importadas > 0) {
        resultados.push({
          codigo: item.codigo,
          importadas: resultado.importadas
        });
      }
    }
    
    res.json({
      message: 'Detecção automática concluída para todos os itens',
      totalItens: itens.length,
      totalImportadas,
      totalJaExistentes,
      itensComNovasImagens: resultados
    });
    
  } catch (error) {
    console.error('Erro na detecção para todos os itens:', error);
    res.status(500).json({ 
      error: 'Erro na detecção automática',
      details: error.message 
    });
  }
});

// Configuração específica do multer para arquivos Excel
const excelSetoresUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, 'setores-' + uniqueSuffix + path.extname(file.originalname));
    }
  }),
  fileFilter: (req, file, cb) => {
    // Aceitar arquivos Excel
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.xlsx') ||
        file.originalname.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos Excel (.xlsx, .xls) são permitidos!'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
});

// Rota para importar setores via upload de arquivo Excel
app.post('/api/importar-setores', authenticateToken, excelSetoresUpload.single('file'), async (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo foi enviado' });
    }

    const filePath = req.file.path;
    const fileExtension = path.extname(req.file.originalname).toLowerCase();

    if (fileExtension !== '.xlsx' && fileExtension !== '.xls') {
      // Remover arquivo inválido
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'Formato de arquivo não suportado. Use .xlsx ou .xls' });
    }

    console.log('📁 Processando arquivo:', req.file.originalname);

    // Ler arquivo Excel
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const dados = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Total de linhas lidas: ${dados.length}`);

    // Processar dados
    const resultados = {
      total: dados.length,
      processados: 0,
      sucesso: 0,
      erros: 0,
      setoresInvalidos: 0,
      itensNaoEncontrados: 0,
      detalhes: []
    };

    console.log('🔄 Iniciando processamento dos dados...');

    for (let i = 0; i < dados.length; i++) {
      const linha = dados[i];
      const codigo = linha.Artigo || linha.codigo || linha.CODIGO || linha.artigo;
      const setoresString = linha.SETOR || linha.setor || linha.Setor || '';

      // Mostrar progresso a cada 50 itens
      if ((i + 1) % 50 === 0) {
        const percentual = Math.round(((i + 1) / dados.length) * 100);
        console.log(`📈 Progresso: ${i + 1}/${dados.length} (${percentual}%)`);
      }

      if (!codigo) {
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: 'N/A',
          setores: setoresString,
          erro: 'Código do item não encontrado'
        });
        continue;
      }

      resultados.processados++;

      try {
        // Buscar o item pelo código
        const itemResult = await pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo]);
        
        if (itemResult.rows.length === 0) {
          resultados.itensNaoEncontrados++;
          resultados.detalhes.push({
            linha: i + 1,
            codigo: codigo,
            setores: setoresString,
            erro: 'Item não encontrado no banco de dados'
          });
          continue;
        }

        const itemId = itemResult.rows[0].id;

        // Processar setores (separados por vírgula)
        const setoresArray = setoresString
          .split(',')
          .map(setor => setor.trim().toUpperCase())
          .filter(setor => setor.length > 0 && setor !== '')
          .filter((setor, index, array) => array.indexOf(setor) === index); // Remover duplicatas

        // Validar setores
        const setoresValidos = [];
        const setoresInvalidos = [];

        for (const setor of setoresArray) {
          if (SETORES_VALIDOS.includes(setor)) {
            setoresValidos.push(setor);
          } else {
            setoresInvalidos.push(setor);
          }
        }

        if (setoresInvalidos.length > 0) {
          resultados.setoresInvalidos++;
          resultados.detalhes.push({
            linha: i + 1,
            codigo: codigo,
            setores: setoresString,
            setoresValidos: setoresValidos,
            setoresInvalidos: setoresInvalidos,
            erro: 'Alguns setores são inválidos'
          });
        }

        if (setoresValidos.length > 0) {
          // Remover setores existentes do item
          await pool.query('DELETE FROM itens_setores WHERE item_id = $1', [itemId]);

          // Inserir novos setores válidos
          for (const setor of setoresValidos) {
            await pool.query(
              'INSERT INTO itens_setores (item_id, setor) VALUES ($1, $2)',
              [itemId, setor]
            );
          }

          resultados.sucesso++;
          console.log(`✅ ${codigo}: ${setoresValidos.join(', ')}`);
        }

      } catch (error) {
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          setores: setoresString,
          erro: error.message
        });
      }
    }

    // Remover arquivo temporário
    fs.unlinkSync(filePath);

    console.log('📊 Estatísticas da importação:', {
      total: resultados.total,
      sucesso: resultados.sucesso,
      erros: resultados.erros,
      itensNaoEncontrados: resultados.itensNaoEncontrados,
      setoresInvalidos: resultados.setoresInvalidos
    });

    res.json({
      message: 'Importação concluída',
      ...resultados
    });

  } catch (error) {
    console.error('❌ Erro durante a importação:', error);
    
    // Remover arquivo em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Erro durante a importação',
      details: error.message 
    });
  }
});

// Rota para download do template de setores
app.get('/api/download-template-setores', authenticateToken, (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    // Criar dados de exemplo
    const dados = [
      { Artigo: '3000003', SETOR: 'MOVEL' },
      { Artigo: '3000004', SETOR: 'MOVEL' },
      { Artigo: '3000020', SETOR: 'MOVEL, FIBRA' },
      { Artigo: '3000022', SETOR: 'FIBRA, CLIENTE, ENGENHARIA' },
      { Artigo: '3000023', SETOR: 'IT, LOGISTICA' }
    ];

    // Criar workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(dados);

    // Definir largura das colunas
    worksheet['!cols'] = [
      { width: 15 }, // Artigo
      { width: 40 }  // SETOR
    ];

    // Adicionar worksheet ao workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Setores');

    // Gerar buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Configurar headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template_setores.xlsx"');
    res.setHeader('Content-Length', buffer.length);

    // Enviar arquivo
    res.send(buffer);

  } catch (error) {
    console.error('❌ Erro ao gerar template:', error);
    res.status(500).json({ 
      error: 'Erro ao gerar template',
      details: error.message 
    });
  }
});

// Rota para importar unidades de armazenamento
app.post('/api/importar-unidades', authenticateToken, excelSetoresUpload.single('file'), async (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const filePath = req.file.path;
    console.log('📁 Arquivo recebido:', req.file.originalname);

    // Unidades válidas
    const UNIDADES_VALIDAS = [
      'UN', 'KG', 'M', 'L', 'PÇ', 'ROL', 'CAIXA', 'PACOTE',
      'METRO', 'LITRO', 'QUILO', 'PECA', 'UNIDADE', 'CM', 'MM',
      'TON', 'G', 'ML', 'PCS', 'UNID', 'M2', 'M3', 'LITROS',
      'QUILOS', 'METROS', 'PECAS', 'UNIDADES', 'LT', 'MT'
    ];

    // Ler arquivo Excel
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const dados = XLSX.utils.sheet_to_json(worksheet);

    console.log(`📊 Processando ${dados.length} linhas do arquivo`);

    const resultados = {
      total: dados.length,
      sucesso: 0,
      erros: 0,
      itensNaoEncontrados: 0,
      unidadesInvalidas: 0,
      detalhes: []
    };

    // Processar cada linha
    for (let i = 0; i < dados.length; i++) {
      const row = dados[i];
      const codigo = row['Artigo']?.toString().trim();
      const unidadeString = row['UNIDADE_ARMAZENAMENTO']?.toString().trim().toUpperCase();

      console.log(`🔍 Processando linha ${i + 1}: ${codigo} -> ${unidadeString}`);

      if (!codigo) {
        console.log(`❌ Linha ${i + 1}: Código vazio`);
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: 'N/A',
          erro: 'Código do artigo não encontrado'
        });
        continue;
      }

      // Validar unidade
      if (unidadeString && !UNIDADES_VALIDAS.includes(unidadeString)) {
        resultados.unidadesInvalidas++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          erro: 'Unidade de armazenamento inválida',
          unidadeInvalida: unidadeString
        });
        continue;
      }

      try {
        // Buscar item pelo código
        const { rows: itens } = await pool.query(
          'SELECT id FROM itens WHERE codigo = $1',
          [codigo]
        );

        if (itens.length === 0) {
          resultados.itensNaoEncontrados++;
          resultados.detalhes.push({
            linha: i + 1,
            codigo: codigo,
            erro: 'Item não encontrado no sistema'
          });
          continue;
        }

        const itemId = itens[0].id;

        // Atualizar unidade de armazenamento
        await pool.query(
          'UPDATE itens SET unidadearmazenamento = $1 WHERE id = $2',
          [unidadeString || null, itemId]
        );

        resultados.sucesso++;
        console.log(`✅ Item ${codigo} atualizado com unidade: ${unidadeString || 'null'}`);
        console.log(`📊 Progresso: ${i + 1}/${dados.length} (${Math.round(((i + 1) / dados.length) * 100)}%)`);

      } catch (error) {
        resultados.erros++;
        resultados.detalhes.push({
          linha: i + 1,
          codigo: codigo,
          erro: error.message
        });
      }
    }

    // Remover arquivo temporário
    fs.unlinkSync(filePath);

    console.log('📊 Estatísticas da importação de unidades:', {
      total: resultados.total,
      sucesso: resultados.sucesso,
      erros: resultados.erros,
      itensNaoEncontrados: resultados.itensNaoEncontrados,
      unidadesInvalidas: resultados.unidadesInvalidas
    });

    res.json({
      message: 'Importação de unidades concluída',
      ...resultados
    });

  } catch (error) {
    console.error('❌ Erro durante a importação de unidades:', error);
    
    // Remover arquivo em caso de erro
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Erro durante a importação de unidades',
      details: error.message 
    });
  }
});

// Rota para download do template de unidades
app.get('/api/download-template-unidades', authenticateToken, (req, res) => {
  try {
    // Verificar se é admin ou controller
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'controller')) {
      return res.status(403).json({ error: 'Acesso negado.' });
    }

    // Criar dados de exemplo
    const dados = [
      { Artigo: '3000003', UNIDADE_ARMAZENAMENTO: 'UN' },
      { Artigo: '3000004', UNIDADE_ARMAZENAMENTO: 'KG' },
      { Artigo: '3000020', UNIDADE_ARMAZENAMENTO: 'M' },
      { Artigo: '3000022', UNIDADE_ARMAZENAMENTO: 'L' },
      { Artigo: '3000023', UNIDADE_ARMAZENAMENTO: 'PÇ' }
    ];

    // Criar workbook
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(dados);

    // Definir largura das colunas
    worksheet['!cols'] = [
      { width: 15 }, // Artigo
      { width: 25 }  // UNIDADE_ARMAZENAMENTO
    ];

    // Adicionar worksheet ao workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Unidades');

    // Gerar buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    // Configurar headers
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="template_unidades.xlsx"');
    res.setHeader('Content-Length', buffer.length);

    // Enviar arquivo
    res.send(buffer);

  } catch (error) {
    console.error('❌ Erro ao gerar template de unidades:', error);
    res.status(500).json({ 
      error: 'Erro ao gerar template de unidades',
      details: error.message 
    });
  }
});

// ============================================
// ROTAS DE ARMAZÉNS
// ============================================

// Listar todos os armazéns (com localizações quando a tabela existir)
app.get('/api/armazens', authenticateToken, async (req, res) => {
  try {
    const { ativo } = req.query;
    let query = 'SELECT * FROM armazens WHERE 1=1';
    const params = [];

    if (ativo !== undefined) {
      query += ' AND ativo = $1';
      params.push(ativo === 'true');
    }

    query += ' ORDER BY codigo ASC';
    let result;
    try {
      result = await pool.query(query, params);
    } catch (orderError) {
      if (orderError.code === '42703') {
        query = query.replace(' ORDER BY codigo ASC', ' ORDER BY descricao ASC');
        result = await pool.query(query, params);
      } else {
        throw orderError;
      }
    }

    const armazens = result.rows;
    try {
      for (const a of armazens) {
        a.tipo = a.tipo || 'viatura';
        try {
          const locResult = await pool.query(
            'SELECT id, localizacao, tipo_localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
            [a.id]
          );
          a.localizacoes = (locResult.rows || []).map(r => ({ id: r.id, localizacao: r.localizacao, tipo_localizacao: r.tipo_localizacao || 'normal' }));
        } catch (locE) {
          if (locE.code === '42703') {
            const locResult = await pool.query('SELECT id, localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id', [a.id]);
            a.localizacoes = (locResult.rows || []).map(r => ({ ...r, tipo_localizacao: (r.localizacao || '').toUpperCase().includes('.FERR') ? 'FERR' : 'normal' }));
          } else throw locE;
        }
        if (a.localizacoes.length === 0 && a.localizacao) {
          a.localizacoes = [{ id: null, localizacao: a.localizacao, tipo_localizacao: (a.localizacao || '').toString().toUpperCase().includes('.FERR') ? 'FERR' : 'normal' }];
        }
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
      for (const a of armazens) {
        a.tipo = a.tipo || 'viatura';
        a.localizacoes = a.localizacao ? [{ id: null, localizacao: a.localizacao, tipo_localizacao: 'normal' }] : [];
      }
    }
    res.json(armazens);
  } catch (error) {
    // Tabela armazens ainda não criada - retornar lista vazia
    if (error.code === '42P01') {
      console.warn('⚠️ Tabela "armazens" não existe. Execute: server/create-armazens-requisicoes-v2.sql');
      return res.json([]);
    }
    console.error('Erro ao listar armazéns:', error);
    res.status(500).json({ error: 'Erro ao listar armazéns', details: error.message });
  }
});

// Buscar armazém por ID (com localizações)
app.get('/api/armazens/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM armazens WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Armazém não encontrado' });
    }

    const armazem = result.rows[0];
    armazem.tipo = armazem.tipo || 'viatura';
    try {
      try {
        const locResult = await pool.query(
          'SELECT id, localizacao, tipo_localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
          [id]
        );
        armazem.localizacoes = (locResult.rows || []).map(r => ({ id: r.id, localizacao: r.localizacao, tipo_localizacao: r.tipo_localizacao || 'normal' }));
      } catch (locE) {
        if (locE.code === '42703') {
          const locResult = await pool.query('SELECT id, localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id', [id]);
          armazem.localizacoes = (locResult.rows || []).map(r => ({ ...r, tipo_localizacao: (r.localizacao || '').toUpperCase().includes('.FERR') ? 'FERR' : 'normal' }));
        } else throw locE;
      }
      if (armazem.localizacoes.length === 0 && armazem.localizacao) {
        armazem.localizacoes = [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }];
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
      armazem.localizacoes = armazem.localizacao ? [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }] : [];
    }
    res.json(armazem);
  } catch (error) {
    console.error('Erro ao buscar armazém:', error);
    res.status(500).json({ error: 'Erro ao buscar armazém', details: error.message });
  }
});

// Criar novo armazém (apenas admin)
app.post('/api/armazens', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem criar armazéns' });
    }

    const { codigo, descricao, localizacao, localizacoes, tipo } = req.body;

    if (!codigo || !codigo.toString().trim()) {
      return res.status(400).json({ error: 'Código é obrigatório (ex: V848 ou E)' });
    }
    if (!descricao || !descricao.toString().trim()) {
      return res.status(400).json({ error: 'Descrição é obrigatória (ex: BBCH06)' });
    }

    const tipoArmazem = (tipo === 'central' || tipo === 'viatura') ? tipo : 'viatura';
    const codigoNorm = codigo.toString().trim().toUpperCase();
    const descricaoTrim = (descricao || '').trim();

    let locsWithTipo = [];
    if (Array.isArray(localizacoes) && localizacoes.length > 0) {
      locsWithTipo = localizacoes.map(l => {
        if (typeof l === 'object' && l !== null && l.localizacao != null) {
          return { localizacao: String(l.localizacao).trim(), tipo_localizacao: (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal' };
        }
        const s = String(l).trim();
        if (!s) return null;
        return { localizacao: s, tipo_localizacao: s.toUpperCase().includes('.FERR') ? 'FERR' : 'normal' };
      }).filter(Boolean);
    }
    if (localizacao && localizacao.toString().trim()) {
      const s = localizacao.toString().trim();
      if (!locsWithTipo.some(l => l.localizacao === s)) locsWithTipo.unshift({ localizacao: s, tipo_localizacao: s.toUpperCase().includes('.FERR') ? 'FERR' : 'normal' });
    }
    if (tipoArmazem === 'viatura') {
      if (locsWithTipo.length !== 2) {
        locsWithTipo = [
          { localizacao: codigoNorm, tipo_localizacao: 'normal' },
          { localizacao: codigoNorm + '.FERR', tipo_localizacao: 'FERR' }
        ];
      } else {
        const hasFERR = locsWithTipo.some(l => l.tipo_localizacao === 'FERR' || (l.localizacao || '').toUpperCase().includes('.FERR'));
        if (!hasFERR) locsWithTipo[1] = { ...locsWithTipo[1], localizacao: codigoNorm + '.FERR', tipo_localizacao: 'FERR' };
      }
    }
    if (tipoArmazem === 'central') {
      const hasRecebimento = locsWithTipo.some(l => l.tipo_localizacao === 'recebimento');
      const hasExpedicao = locsWithTipo.some(l => l.tipo_localizacao === 'expedicao');
      if (!hasRecebimento || !hasExpedicao) {
        return res.status(400).json({ error: 'Armazém central deve ter pelo menos uma localização de Recebimento e uma ou mais de Expedição.' });
      }
    }

    let result;
    try {
      result = await pool.query(`
        INSERT INTO armazens (codigo, descricao, localizacao, tipo)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [codigoNorm, descricaoTrim, (locsWithTipo[0] && locsWithTipo[0].localizacao) || null, tipoArmazem]);
    } catch (insertError) {
      if (insertError.code === '42703') {
        try {
          result = await pool.query(`
            INSERT INTO armazens (codigo, descricao, localizacao)
            VALUES ($1, $2, $3)
            RETURNING *
          `, [codigoNorm, descricaoTrim, (locsWithTipo[0] && locsWithTipo[0].localizacao) || null]);
          console.log(`✅ Armazém criado (esquema antigo): ${result.rows[0].descricao}`);
          return res.status(201).json(result.rows[0]);
        } catch (fallbackErr) {
          console.error('Erro ao criar armazém (fallback):', fallbackErr);
          return res.status(500).json({
            error: 'Erro ao criar armazém. Execute a migração: server/migrate-armazens-add-codigo.sql',
            details: fallbackErr.message
          });
        }
      }
      throw insertError;
    }

    const armazemId = result.rows[0].id;
    let localizacoesSemTipo = false;
    if (locsWithTipo.length > 0) {
      try {
        for (const loc of locsWithTipo) {
          try {
            await pool.query(
              'INSERT INTO armazens_localizacoes (armazem_id, localizacao, tipo_localizacao) VALUES ($1, $2, $3)',
              [armazemId, loc.localizacao, loc.tipo_localizacao || 'normal']
            );
          } catch (insE) {
            if (insE.code === '42703') {
              await pool.query('INSERT INTO armazens_localizacoes (armazem_id, localizacao) VALUES ($1, $2)', [armazemId, loc.localizacao]);
              localizacoesSemTipo = true;
            } else throw insE;
          }
        }
        if (localizacoesSemTipo) {
          console.warn('⚠️ Coluna tipo_localizacao não existe. Execute: server/migrate-armazens-tipo-central-viatura.sql');
        }
      } catch (e) {
        if (e.code === '42P01') {
          return res.status(503).json({
            error: 'Tabela armazens_localizacoes não existe. Execute a migração:',
            details: 'server/migrate-armazens-multiplas-localizacoes.sql ou server/criar-tabelas-armazens-requisicoes.sql'
          });
        }
        throw e;
      }
    }
    const armazemFinal = result.rows[0];
    armazemFinal.tipo = armazemFinal.tipo || tipoArmazem;
    armazemFinal.localizacoes = locsWithTipo.map((l, i) => ({ id: i + 1, localizacao: l.localizacao, tipo_localizacao: l.tipo_localizacao || 'normal' }));
    if (localizacoesSemTipo) {
      armazemFinal.warning = 'Localizações foram salvas, mas o tipo (Recebimento/Expedição) não. Execute a migração: server/migrate-armazens-tipo-central-viatura.sql';
    }
    console.log(`✅ Armazém criado: ${armazemFinal.codigo} - ${armazemFinal.descricao}`);
    res.status(201).json(armazemFinal);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Já existe um armazém com este código de viatura' });
    }
    if (error.code === '42P01') {
      return res.status(503).json({
        error: 'Tabela "armazens" não existe. Execute o script SQL:',
        details: 'psql -U USUARIO -d NOME_DA_BASE -f server/create-armazens-requisicoes-v2.sql'
      });
    }
    console.error('Erro ao criar armazém:', error);
    res.status(500).json({
      error: 'Erro ao criar armazém',
      details: error.message || String(error)
    });
  }
});

// Atualizar armazém (apenas admin)
app.put('/api/armazens/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem atualizar armazéns' });
    }

    const { id } = req.params;
    const { codigo, descricao, localizacao, localizacoes, ativo, tipo } = req.body;

    const updates = [];
    const params = [];
    let paramCount = 1;

    if (codigo !== undefined && codigo.toString().trim()) {
      updates.push(`codigo = $${paramCount++}`);
      params.push(codigo.toString().trim().toUpperCase());
    }

    if (descricao !== undefined) {
      updates.push(`descricao = $${paramCount++}`);
      params.push(descricao);
    }

    let locsWithTipo = [];
    if (localizacoes !== undefined && Array.isArray(localizacoes)) {
      locsWithTipo = localizacoes.map(l => {
        if (typeof l === 'object' && l !== null && l.localizacao != null) {
          return { localizacao: String(l.localizacao).trim(), tipo_localizacao: (l.tipo_localizacao === 'recebimento' || l.tipo_localizacao === 'expedicao' || l.tipo_localizacao === 'FERR') ? l.tipo_localizacao : 'normal' };
        }
        const s = String(l).trim();
        if (!s) return null;
        return { localizacao: s, tipo_localizacao: s.toUpperCase().includes('.FERR') ? 'FERR' : 'normal' };
      }).filter(Boolean);
    }
    let locVal = locsWithTipo[0]?.localizacao ?? (localizacao !== undefined ? localizacao : undefined);
    if (locVal !== undefined) {
      updates.push(`localizacao = $${paramCount++}`);
      params.push(locVal);
    }

    if (ativo !== undefined) {
      updates.push(`ativo = $${paramCount++}`);
      params.push(ativo);
    }

    if (tipo !== undefined && (tipo === 'central' || tipo === 'viatura')) {
      try {
        updates.push(`tipo = $${paramCount++}`);
        params.push(tipo);
      } catch (_) {}
    }

    const temLocalizacoesParaAtualizar = localizacoes !== undefined && Array.isArray(localizacoes);
    if (updates.length === 0 && !temLocalizacoesParaAtualizar) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    let tipoAtual = tipo;
    if (temLocalizacoesParaAtualizar && tipoAtual === undefined) {
      const arm = await pool.query('SELECT codigo, tipo FROM armazens WHERE id = $1', [id]);
      tipoAtual = arm.rows[0]?.tipo || 'viatura';
    }
    if (temLocalizacoesParaAtualizar && tipoAtual === 'viatura' && locsWithTipo.length !== 2) {
      const arm = await pool.query('SELECT codigo FROM armazens WHERE id = $1', [id]);
      const codigoAtual = arm.rows[0]?.codigo || 'V';
      locsWithTipo = [
        { localizacao: codigoAtual, tipo_localizacao: 'normal' },
        { localizacao: codigoAtual + '.FERR', tipo_localizacao: 'FERR' }
      ];
    }
    if (temLocalizacoesParaAtualizar && tipoAtual === 'central') {
      const hasRecebimento = locsWithTipo.some(l => l.tipo_localizacao === 'recebimento');
      const hasExpedicao = locsWithTipo.some(l => l.tipo_localizacao === 'expedicao');
      if (!hasRecebimento || !hasExpedicao) {
        return res.status(400).json({ error: 'Armazém central deve ter pelo menos uma localização de Recebimento e uma ou mais de Expedição.' });
      }
    }

    if (updates.length > 0) {
      params.push(id);
      const tipoIdx = updates.findIndex(u => u.startsWith('tipo ='));
      try {
        await pool.query(`
          UPDATE armazens 
          SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${paramCount}
        `, params);
      } catch (updE) {
        if (updE.code === '42703' && tipoIdx !== -1) {
          const cleanUpdates = updates.filter((_, i) => i !== tipoIdx);
          const cleanParams = params.slice(0, -1).filter((_, i) => i !== tipoIdx);
          cleanParams.push(id);
          if (cleanUpdates.length > 0) await pool.query(`UPDATE armazens SET ${cleanUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${cleanParams.length}`, cleanParams);
        } else throw updE;
      }
    }

    if (temLocalizacoesParaAtualizar && locsWithTipo.length > 0) {
      try {
        await pool.query('DELETE FROM armazens_localizacoes WHERE armazem_id = $1', [id]);
        for (const loc of locsWithTipo) {
          try {
            await pool.query(
              'INSERT INTO armazens_localizacoes (armazem_id, localizacao, tipo_localizacao) VALUES ($1, $2, $3)',
              [id, loc.localizacao, loc.tipo_localizacao || 'normal']
            );
          } catch (insE) {
            if (insE.code === '42703') {
              await pool.query('INSERT INTO armazens_localizacoes (armazem_id, localizacao) VALUES ($1, $2)', [id, loc.localizacao]);
            } else throw insE;
          }
        }
      } catch (e) {
        if (e.code === '42P01') {
          return res.status(503).json({
            error: 'Tabela armazens_localizacoes não existe. Execute a migração:',
            details: 'server/migrate-armazens-multiplas-localizacoes.sql ou server/criar-tabelas-armazens-requisicoes.sql'
          });
        }
        throw e;
      }
    }

    const result = await pool.query('SELECT * FROM armazens WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Armazém não encontrado' });
    }

    const armazem = result.rows[0];
    armazem.tipo = armazem.tipo || 'viatura';
    try {
      try {
        const locResult = await pool.query(
          'SELECT id, localizacao, tipo_localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
          [id]
        );
        armazem.localizacoes = (locResult.rows || []).map(r => ({ id: r.id, localizacao: r.localizacao, tipo_localizacao: r.tipo_localizacao || 'normal' }));
      } catch (locE) {
        if (locE.code === '42703') {
          const locResult = await pool.query('SELECT id, localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id', [id]);
          armazem.localizacoes = (locResult.rows || []).map(r => ({ ...r, tipo_localizacao: (r.localizacao || '').toUpperCase().includes('.FERR') ? 'FERR' : 'normal' }));
        } else throw locE;
      }
      if (armazem.localizacoes.length === 0 && armazem.localizacao) {
        armazem.localizacoes = [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }];
      }
    } catch (e) {
      if (e.code !== '42P01') throw e;
      armazem.localizacoes = armazem.localizacao ? [{ id: null, localizacao: armazem.localizacao, tipo_localizacao: 'normal' }] : [];
    }

    console.log(`✅ Armazém atualizado: ID ${id}`);
    res.json(armazem);
  } catch (error) {
    console.error('Erro ao atualizar armazém:', error);
    res.status(500).json({ error: 'Erro ao atualizar armazém', details: error.message });
  }
});

// Deletar armazém (apenas admin)
app.delete('/api/armazens/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem deletar armazéns' });
    }

    const { id } = req.params;
    await pool.query('DELETE FROM armazens WHERE id = $1', [id]);

    console.log(`✅ Armazém deletado: ID ${id}`);
    res.json({ message: 'Armazém deletado com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar armazém:', error);
    res.status(500).json({ error: 'Erro ao deletar armazém', details: error.message });
  }
});

// ============================================
// ROTAS DE REQUISIÇÕES (V2 - Múltiplos Itens)
// ============================================

// Listar todas as requisições (com informações dos itens)
app.get('/api/requisicoes', authenticateToken, async (req, res) => {
  try {
    const { status, armazem_id, item_id } = req.query;
    
    // Buscar requisições (armazem destino + armazem origem)
    let query = `
      SELECT 
        r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        u.nome as usuario_nome,
        u.email as usuario_email
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (status) {
      query += ` AND r.status = $${paramCount++}`;
      params.push(status);
    }

    if (armazem_id) {
      query += ` AND r.armazem_id = $${paramCount++}`;
      params.push(armazem_id);
    }

    query += ` ORDER BY r.created_at DESC`;

    let requisicoesResult;
    try {
      requisicoesResult = await pool.query(query, params);
    } catch (qErr) {
      if (qErr.code === '42703') {
        let fallbackQuery = `
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            u.nome as usuario_nome, u.email as usuario_email
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE 1=1
        `;
        let pc = 1;
        if (status) { fallbackQuery += ` AND r.status = $${pc++}`; }
        if (armazem_id) { fallbackQuery += ` AND r.armazem_id = $${pc++}`; }
        fallbackQuery += ` ORDER BY r.created_at DESC`;
        requisicoesResult = await pool.query(fallbackQuery, params);
      } else {
        throw qErr;
      }
    }
    const requisicoes = requisicoesResult.rows;

    // Para cada requisição, buscar seus itens
    for (let req of requisicoes) {
      let itensQuery = `
        SELECT 
          ri.*,
          i.codigo as item_codigo,
          i.descricao as item_descricao
        FROM requisicoes_itens ri
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
      `;
      
      if (item_id) {
        itensQuery += ` AND ri.item_id = $2`;
        const itensResult = await pool.query(itensQuery, [req.id, item_id]);
        req.itens = itensResult.rows;
      } else {
        const itensResult = await pool.query(itensQuery, [req.id]);
        req.itens = itensResult.rows;
      }
    }

    // Filtrar requisições que não têm o item_id especificado (se filtro aplicado)
    const filteredRequisicoes = item_id 
      ? requisicoes.filter(r => r.itens && r.itens.length > 0)
      : requisicoes;

    res.json(filteredRequisicoes);
  } catch (error) {
    // Tabelas de requisições ainda não criadas - retornar lista vazia
    if (error.code === '42P01') {
      console.warn('⚠️ Tabelas "requisicoes" ou "armazens" não existem. Execute: server/create-armazens-requisicoes-v2.sql');
      return res.json([]);
    }
    console.error('Erro ao listar requisições:', error);
    res.status(500).json({ error: 'Erro ao listar requisições', details: error.message });
  }
});

// Exportar requisição no formato exigido pelo sistema da empresa (uma folha, colunas fixas)
app.get('/api/requisicoes/:id/export-excel', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    let reqResult;
    try {
      reqResult = await pool.query(`
        SELECT r.*,
          a.codigo as armazem_destino_codigo,
          ao.codigo as armazem_origem_codigo,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          u.nome as usuario_nome
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        reqResult = await pool.query(`
          SELECT r.*,
            a.codigo as armazem_destino_codigo,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            u.nome as usuario_nome
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
        if (reqResult.rows[0]) {
          reqResult.rows[0].armazem_origem_descricao = null;
          reqResult.rows[0].armazem_origem_codigo = null;
        }
      } else throw qErr;
    }

    if (reqResult.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    const requisicao = reqResult.rows[0];
    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao,
        i.familia as item_familia, i.subfamilia as item_subfamilia
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [id]);
    requisicao.itens = itensResult.rows;

    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;
    const codigoOrigem = requisicao.armazem_origem_codigo || '';
    const codigoDestino = requisicao.armazem_destino_codigo || '';

    const rows = (requisicao.itens || []).map(ri => ({
      Date: dateStr,
      OriginWarehouse: codigoOrigem,
      OriginLocation: ri.localizacao_origem || '',
      Article: String(ri.item_codigo || ''),
      Quatity: parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0,
      SerialNumber1: '',
      SerialNumber2: '',
      MacAddress: '',
      CentroCusto: '',
      DestinationWarehouse: codigoDestino,
      DestinationLocation: ri.localizacao_destino || codigoDestino,
      ProjectCode: '',
      Batch: ''
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{
      Date: '', OriginWarehouse: '', OriginLocation: '', Article: '', Quatity: '',
      SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
      DestinationWarehouse: '', DestinationLocation: '', ProjectCode: '', Batch: ''
    }], { header: ['Date', 'OriginWarehouse', 'OriginLocation', 'Article', 'Quatity', 'SerialNumber1', 'SerialNumber2', 'MacAddress', 'CentroCusto', 'DestinationWarehouse', 'DestinationLocation', 'ProjectCode', 'Batch'] });

    XLSX.utils.book_append_sheet(wb, ws, 'Requisição');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Erro ao exportar requisição para Excel:', error);
    res.status(500).json({ error: 'Erro ao exportar requisição', details: error.message });
  }
});

// Constante: localização de expedição no armazém E (para TRFL destino e TRA origem)
const LOCALIZACAO_EXPEDICAO_E = 'EXPEDICAO.E';

// Helper: gera buffer Excel com as colunas padrão (Date, OriginWarehouse, ... Batch)
function buildExcelTransferencia(rows, res, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{
    Date: '', OriginWarehouse: '', OriginLocation: '', Article: '', Quatity: '',
    SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
    DestinationWarehouse: '', DestinationLocation: '', ProjectCode: '', Batch: ''
  }], { header: ['Date', 'OriginWarehouse', 'OriginLocation', 'Article', 'Quatity', 'SerialNumber1', 'SerialNumber2', 'MacAddress', 'CentroCusto', 'DestinationWarehouse', 'DestinationLocation', 'ProjectCode', 'Batch'] });
  XLSX.utils.book_append_sheet(wb, ws, 'Dados');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

// Buscar requisição + itens (reutilizado por TRFL e TRA)
async function getRequisicaoComItens(id) {
  let reqResult = await pool.query(`
    SELECT r.*,
      a.codigo as armazem_destino_codigo,
      ao.codigo as armazem_origem_codigo
    FROM requisicoes r
    INNER JOIN armazens a ON r.armazem_id = a.id
    LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
    WHERE r.id = $1
  `, [id]);
  if (reqResult.rows.length === 0) return null;
  const requisicao = reqResult.rows[0];
  const itensResult = await pool.query(`
    SELECT ri.*, i.codigo as item_codigo
    FROM requisicoes_itens ri
    INNER JOIN itens i ON ri.item_id = i.id
    WHERE ri.requisicao_id = $1
    ORDER BY ri.id
  `, [id]);
  requisicao.itens = itensResult.rows;
  return requisicao;
}

// TRFL — Transferência de localização: origem (E + localização do item) → destino (E + EXPEDICAO.E)
app.get('/api/requisicoes/:id/export-trfl', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicao.separacao_confirmada) {
      return res.status(400).json({ error: 'TRFL só está disponível após confirmar a separação da requisição.' });
    }
    if (!['separado', 'EM EXPEDICAO', 'Entregue'].includes(requisicao.status)) {
      return res.status(400).json({ error: 'TRFL só está disponível após confirmar a separação (status Separado). Conclua a preparação primeiro.' });
    }

    const codigoE = requisicao.armazem_origem_codigo || 'E';
    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

    const rows = (requisicao.itens || []).map(ri => ({
      Date: dateStr,
      OriginWarehouse: codigoE,
      OriginLocation: ri.localizacao_origem || '',
      Article: String(ri.item_codigo || ''),
      Quatity: parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0,
      SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
      DestinationWarehouse: codigoE,
      DestinationLocation: LOCALIZACAO_EXPEDICAO_E,
      ProjectCode: '', Batch: ''
    }));

    buildExcelTransferencia(rows, res, `TRFL_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (requisicao.status === 'separado') {
      await pool.query('UPDATE requisicoes SET status = $1 WHERE id = $2', ['EM EXPEDICAO', id]);
    }
  } catch (error) {
    console.error('Erro ao exportar TRFL:', error);
    res.status(500).json({ error: 'Erro ao exportar TRFL', details: error.message });
  }
});

// TRA — Transferência: origem (E + EXPEDICAO.E) → destino (Vxxx). Ferramentas → .FERR, outros → localização sem .FERR
app.get('/api/requisicoes/:id/export-tra', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const requisicao = await getRequisicaoComItens(id);
    if (!requisicao) return res.status(404).json({ error: 'Requisição não encontrada' });
    if (!requisicao.separacao_confirmada) {
      return res.status(400).json({ error: 'TRA só está disponível após confirmar a separação da requisição.' });
    }
    if (!['EM EXPEDICAO', 'Entregue'].includes(requisicao.status)) {
      return res.status(400).json({ error: 'TRA só está disponível após concluir a TRFL (requisição deve estar Em expedição). Baixe o ficheiro TRFL primeiro.' });
    }

    const codigoE = requisicao.armazem_origem_codigo || 'E';
    const codigoDestino = requisicao.armazem_destino_codigo || '';
    const armazemDestinoId = requisicao.armazem_id;

    // Localizações do armazém destino: uma com .FERR (ferramentas) e outra sem (demais itens)
    let localizacaoFERR = codigoDestino + '.FERR';
    let localizacaoNormal = codigoDestino;
    try {
      const locResult = await pool.query(
        'SELECT localizacao FROM armazens_localizacoes WHERE armazem_id = $1 ORDER BY id',
        [armazemDestinoId]
      );
      if (locResult.rows.length > 0) {
        const locs = locResult.rows.map(r => r.localizacao);
        const comFerr = locs.find(l => (l || '').toUpperCase().includes('.FERR'));
        const semFerr = locs.find(l => !(l || '').toUpperCase().includes('.FERR'));
        if (comFerr) localizacaoFERR = comFerr;
        if (semFerr) localizacaoNormal = semFerr;
      }
    } catch (_) {
      // Tabela pode não existir; usar codigo e codigo.FERR
    }

    // Itens com flag is_ferramenta (setor FERRAMENTA em itens_setores)
    let itensComFerramenta = [];
    try {
      const itensResult = await pool.query(`
        SELECT ri.*, i.codigo as item_codigo,
          EXISTS (
            SELECT 1 FROM itens_setores is2
            WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
          ) as is_ferramenta
        FROM requisicoes_itens ri
        INNER JOIN itens i ON ri.item_id = i.id
        WHERE ri.requisicao_id = $1
        ORDER BY ri.id
      `, [id]);
      itensComFerramenta = itensResult.rows;
    } catch (_) {
      itensComFerramenta = (requisicao.itens || []).map(ri => ({ ...ri, is_ferramenta: false }));
    }

    const dataFormat = new Date(requisicao.created_at);
    const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;

    const rows = itensComFerramenta.map(ri => ({
      Date: dateStr,
      OriginWarehouse: codigoE,
      OriginLocation: LOCALIZACAO_EXPEDICAO_E,
      Article: String(ri.item_codigo || ''),
      Quatity: parseInt(ri.quantidade_preparada ?? ri.quantidade, 10) || 0,
      SerialNumber1: '', SerialNumber2: '', MacAddress: '', CentroCusto: '',
      DestinationWarehouse: codigoDestino,
      DestinationLocation: ri.is_ferramenta ? localizacaoFERR : localizacaoNormal,
      ProjectCode: '', Batch: ''
    }));

    buildExcelTransferencia(rows, res, `TRA_requisicao_${id}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (requisicao.status === 'EM EXPEDICAO') {
      await pool.query('UPDATE requisicoes SET status = $1 WHERE id = $2', ['Entregue', id]);
    }
  } catch (error) {
    console.error('Erro ao exportar TRA:', error);
    res.status(500).json({ error: 'Erro ao exportar TRA', details: error.message });
  }
});

// Buscar requisição por ID (com todos os itens)
app.get('/api/requisicoes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    let reqResult;
    try {
      reqResult = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          a.localizacao as armazem_localizacao,
          u.nome as usuario_nome, u.email as usuario_email
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        reqResult = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            u.nome as usuario_nome, u.email as usuario_email
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
      } else {
        throw qErr;
      }
    }

    if (reqResult.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    const requisicao = reqResult.rows[0];

    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao,
        i.familia as item_familia, i.subfamilia as item_subfamilia
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [id]);

    requisicao.itens = (itensResult.rows || []).map(it => ({
      ...it,
      preparacao_confirmada: it.preparacao_confirmada === true
    }));
    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao buscar requisição:', error);
    res.status(500).json({ error: 'Erro ao buscar requisição', details: error.message });
  }
});

// Criar nova requisição (com múltiplos itens)
app.post('/api/requisicoes', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { armazem_origem_id, armazem_id, itens, observacoes } = req.body;

    // Validações
    if (!armazem_id || !itens || !Array.isArray(itens) || itens.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Campos obrigatórios: armazem_id (destino), itens (array com pelo menos um item)' 
      });
    }

    // Verificar armazém destino
    const armazemCheck = await client.query('SELECT id FROM armazens WHERE id = $1 AND ativo = true', [armazem_id]);
    if (armazemCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Armazém destino não encontrado ou inativo' });
    }

    // Verificar armazém origem (se informado)
    if (armazem_origem_id) {
      const origCheck = await client.query('SELECT id FROM armazens WHERE id = $1 AND ativo = true', [armazem_origem_id]);
      if (origCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Armazém origem não encontrado ou inativo' });
      }
    }

    // Validar itens
    for (const item of itens) {
      if (!item.item_id || !item.quantidade || item.quantidade <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Cada item deve ter item_id e quantidade > 0' 
        });
      }

      // Verificar se o item existe
      const itemCheck = await client.query('SELECT id FROM itens WHERE id = $1', [item.item_id]);
      if (itemCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Item ID ${item.item_id} não encontrado` });
      }
    }

    // Criar requisição (etapa 1: origem, itens, destino - sem localização)
    let reqResult;
    try {
      reqResult = await client.query(`
        INSERT INTO requisicoes (armazem_origem_id, armazem_id, observacoes, usuario_id, status)
        VALUES ($1, $2, $3, $4, 'pendente')
        RETURNING *
      `, [armazem_origem_id || null, armazem_id, observacoes || null, req.user.userId]);
    } catch (insertErr) {
      if (insertErr.code === '42703') {
        reqResult = await client.query(`
          INSERT INTO requisicoes (armazem_id, observacoes, usuario_id, status)
          VALUES ($1, $2, $3, 'pendente')
          RETURNING *
        `, [armazem_id, observacoes || null, req.user.userId]);
      } else {
        throw insertErr;
      }
    }

    const requisicaoId = reqResult.rows[0].id;

    // Inserir itens
    for (const item of itens) {
      await client.query(`
        INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
        VALUES ($1, $2, $3)
        ON CONFLICT (requisicao_id, item_id) 
        DO UPDATE SET quantidade = EXCLUDED.quantidade
      `, [requisicaoId, item.item_id, item.quantidade]);
    }

    await client.query('COMMIT');

    // Buscar requisição completa
    let requisicaoCompleta;
    try {
      requisicaoCompleta = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          u.nome as usuario_nome, u.email as usuario_email
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [requisicaoId]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        requisicaoCompleta = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            u.nome as usuario_nome, u.email as usuario_email
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [requisicaoId]);
      } else {
        throw qErr;
      }
    }

    const requisicao = requisicaoCompleta.rows[0];

    // Buscar itens
    const itensResult = await pool.query(`
      SELECT 
        ri.*,
        i.codigo as item_codigo,
        i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [requisicaoId]);

    requisicao.itens = itensResult.rows;

    console.log(`✅ Requisição criada: ID ${requisicaoId} com ${itens.length} item(ns)`);
    res.status(201).json(requisicao);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar requisição:', error);
    res.status(500).json({ error: 'Erro ao criar requisição', details: error.message });
  } finally {
    client.release();
  }
});

// Atualizar requisição
app.put('/api/requisicoes/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id } = req.params;
    const { armazem_origem_id, armazem_id, itens, status, localizacao, observacoes } = req.body;

    // Verificar se a requisição existe
    const checkReq = await client.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    if (checkReq.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    // Validações
    if (status && !['pendente', 'separado', 'EM EXPEDICAO', 'Entregue', 'cancelada'].includes(status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Status inválido. Use: pendente, separado, EM EXPEDICAO, Entregue ou cancelada' });
    }

    // Construir query de atualização dinamicamente
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (armazem_origem_id !== undefined) {
      if (armazem_origem_id) {
        const origCheck = await client.query('SELECT id FROM armazens WHERE id = $1 AND ativo = true', [armazem_origem_id]);
        if (origCheck.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Armazém origem não encontrado ou inativo' });
        }
      }
      updates.push(`armazem_origem_id = $${paramCount++}`);
      params.push(armazem_origem_id || null);
    }

    if (armazem_id !== undefined) {
      const armazemCheck = await client.query('SELECT id FROM armazens WHERE id = $1 AND ativo = true', [armazem_id]);
      if (armazemCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Armazém destino não encontrado ou inativo' });
      }
      updates.push(`armazem_id = $${paramCount++}`);
      params.push(armazem_id);
    }

    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      params.push(status);
    }

    if (localizacao !== undefined) {
      updates.push(`localizacao = $${paramCount++}`);
      params.push(localizacao);
    }

    if (observacoes !== undefined) {
      updates.push(`observacoes = $${paramCount++}`);
      params.push(observacoes);
    }

    // Atualizar requisição se houver campos para atualizar
    if (updates.length > 0) {
      params.push(id);
      await client.query(`
        UPDATE requisicoes 
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramCount}
      `, params);
    }

    // Atualizar itens se fornecidos
    if (itens && Array.isArray(itens)) {
      // Validar itens
      for (const item of itens) {
        if (!item.item_id || !item.quantidade || item.quantidade <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cada item deve ter item_id e quantidade > 0' });
        }
      }

      // Remover itens existentes
      await client.query('DELETE FROM requisicoes_itens WHERE requisicao_id = $1', [id]);

      // Inserir novos itens
      for (const item of itens) {
        await client.query(`
          INSERT INTO requisicoes_itens (requisicao_id, item_id, quantidade)
          VALUES ($1, $2, $3)
        `, [id, item.item_id, item.quantidade]);
      }
    }

    await client.query('COMMIT');

    // Buscar requisição completa atualizada
    let requisicaoCompleta;
    try {
      requisicaoCompleta = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          u.nome as usuario_nome, u.email as usuario_email
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        requisicaoCompleta = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            u.nome as usuario_nome, u.email as usuario_email
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
      } else {
        throw qErr;
      }
    }

    const requisicao = requisicaoCompleta.rows[0];

    // Buscar itens
    const itensResult = await pool.query(`
      SELECT 
        ri.*,
        i.codigo as item_codigo,
        i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [id]);

    requisicao.itens = itensResult.rows;

    console.log(`✅ Requisição atualizada: ID ${id}`);
    res.json(requisicao);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar requisição:', error);
    res.status(500).json({ error: 'Erro ao atualizar requisição', details: error.message });
  } finally {
    client.release();
  }
});

// Preparar item individual da requisição (quantidade, localização origem, localização destino)
app.patch('/api/requisicoes/:id/atender-item', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { requisicao_item_id, quantidade_preparada, localizacao_origem, localizacao_destino } = req.body;

    if (!requisicao_item_id || quantidade_preparada === undefined || quantidade_preparada < 0) {
      return res.status(400).json({ error: 'requisicao_item_id e quantidade_preparada são obrigatórios (use 0 se não tiver o item).' });
    }
    const locOrigem = typeof localizacao_origem === 'string' ? localizacao_origem.trim() : '';
    if (!locOrigem) {
      return res.status(400).json({ error: 'Localização de saída (onde está saindo) é obrigatória.' });
    }

    const check = await pool.query('SELECT id, status FROM requisicoes WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (['EM EXPEDICAO', 'Entregue'].includes(check.rows[0].status)) {
      return res.status(400).json({ error: 'Requisição já em expedição ou entregue; não é possível alterar a preparação.' });
    }
    if (check.rows[0].status === 'cancelada') {
      return res.status(400).json({ error: 'Requisição cancelada' });
    }
    // pendente e separado: permitido (preparar ou editar item)

    const itemCheck = await pool.query(
      'SELECT * FROM requisicoes_itens WHERE id = $1 AND requisicao_id = $2',
      [requisicao_item_id, id]
    );
    if (itemCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado nesta requisição' });
    }
    const item = itemCheck.rows[0];
    if (quantidade_preparada > item.quantidade) {
      return res.status(400).json({ error: `Quantidade preparada não pode exceder ${item.quantidade}` });
    }

    // Localização destino é sempre EXPEDICAO (automático)
    const localizacaoDestinoFinal = 'EXPEDICAO';

    const updateQuery = `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, localizacao_destino = $2, localizacao_origem = $3, preparacao_confirmada = true
      WHERE id = $4`;
    const params = [quantidade_preparada, localizacaoDestinoFinal, locOrigem, requisicao_item_id];

    try {
      await pool.query(updateQuery, params);
    } catch (e) {
      if (e.code === '42703') {
        return res.status(503).json({
          error: 'Erro ao preparar item: coluna preparacao_confirmada não existe no banco.',
          details: 'Execute a migração: npm run db:migrate:preparacao-confirmada (ou server/migrate-requisicoes-itens-preparacao-confirmada.sql)'
        });
      }
      throw e;
    }

    // Não alterar aqui o status para 'separado' — o utilizador usa o botão "Completar separação" na interface
    const fullReq = await pool.query(`
      SELECT r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        u.nome as usuario_nome
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE r.id = $1
    `, [id]);
    const requisicao = fullReq.rows[0];
    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `, [id]);
    requisicao.itens = (itensResult.rows || []).map(it => ({
      ...it,
      preparacao_confirmada: it.preparacao_confirmada === true
    }));

    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao preparar item:', error);
    res.status(500).json({ error: 'Erro ao preparar item', details: error.message });
  }
});

// Atender requisição (marcar como separado e opcionalmente preencher localização) — legado/alternativo
app.patch('/api/requisicoes/:id/atender', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { localizacao } = req.body;

    const check = await pool.query('SELECT id, status FROM requisicoes WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (['separado', 'EM EXPEDICAO', 'Entregue'].includes(check.rows[0].status)) {
      return res.status(400).json({ error: 'Requisição já foi preparada' });
    }
    if (check.rows[0].status === 'cancelada') {
      return res.status(400).json({ error: 'Requisição cancelada' });
    }

    await pool.query(`
      UPDATE requisicoes 
      SET status = 'separado', localizacao = COALESCE($2, localizacao), updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [id, localizacao || null]);

    let result;
    try {
      result = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          u.nome as usuario_nome
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `, [id]);
    } catch (qErr) {
      if (qErr.code === '42703') {
        result = await pool.query(`
          SELECT r.*,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            u.nome as usuario_nome
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `, [id]);
      } else {
        throw qErr;
      }
    }

    const requisicao = result.rows[0];
    const itensResult = await pool.query(`
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
    `, [id]);
    requisicao.itens = itensResult.rows;

    console.log(`✅ Requisição marcada como separado: ID ${id}`);
    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao atender requisição:', error);
    res.status(500).json({ error: 'Erro ao atender requisição', details: error.message });
  }
});

// Completar separação da requisição (todos os itens preparados → status separado)
app.patch('/api/requisicoes/:id/completar-separacao', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT id, status FROM requisicoes WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (check.rows[0].status !== 'pendente') {
      return res.status(400).json({ error: 'Só pode completar a separação quando a requisição está pendente e todos os itens foram preparados.' });
    }
    let itens;
    try {
      itens = await pool.query(
        'SELECT quantidade, quantidade_preparada, preparacao_confirmada FROM requisicoes_itens WHERE requisicao_id = $1',
        [id]
      );
    } catch (qErr) {
      if (qErr.code === '42703') {
        return res.status(503).json({
          error: 'É obrigatório confirmar a preparação de cada item (incl. 0 quando não houver stock).',
          details: 'Execute a migração: server/migrate-requisicoes-itens-preparacao-confirmada.sql'
        });
      }
      throw qErr;
    }
    const allConfirmed = itens.rows.length > 0 && itens.rows.every(r => r.preparacao_confirmada === true);
    if (!allConfirmed) {
      return res.status(400).json({ error: 'Confirme a preparação de todos os itens antes de completar a separação (inclua 0 na quantidade quando não tiver o item).' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['separado', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao completar separação:', error);
    res.status(500).json({ error: 'Erro ao completar separação', details: error.message });
  }
});

// Confirmar separação (após os itens terem sido recolhidos) — só para requisições com status separado
app.patch('/api/requisicoes/:id/confirmar-separacao', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT id, status FROM requisicoes WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (check.rows[0].status !== 'separado') {
      return res.status(400).json({ error: 'Só é possível confirmar separação quando a requisição está separada (todos os itens preparados).' });
    }
    await pool.query(
      `UPDATE requisicoes SET separacao_confirmada = true, separacao_confirmada_em = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '42703') {
      return res.status(503).json({
        error: 'Colunas de confirmação de separação não existem no banco.',
        details: 'Execute a migração: server/migrate-requisicoes-separacao-confirmada.sql'
      });
    }
    console.error('Erro ao confirmar separação:', error);
    res.status(500).json({ error: 'Erro ao confirmar separação', details: error.message });
  }
});

// Marcar como EM EXPEDICAO (após baixar o ficheiro TRFL)
app.patch('/api/requisicoes/:id/marcar-em-expedicao', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT id, status, separacao_confirmada FROM requisicoes WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (check.rows[0].status !== 'separado') {
      return res.status(400).json({ error: 'Só pode marcar em expedição quando a requisição está separada.' });
    }
    if (!check.rows[0].separacao_confirmada) {
      return res.status(400).json({ error: 'Confirme a separação antes de marcar em expedição.' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['EM EXPEDICAO', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao marcar em expedição:', error);
    res.status(500).json({ error: 'Erro ao marcar em expedição', details: error.message });
  }
});

// Marcar como Entregue (após baixar o ficheiro TRA)
app.patch('/api/requisicoes/:id/marcar-entregue', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT id, status FROM requisicoes WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (check.rows[0].status !== 'EM EXPEDICAO') {
      return res.status(400).json({ error: 'Só pode marcar como entregue quando a requisição está em expedição.' });
    }
    await pool.query(
      'UPDATE requisicoes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['Entregue', id]
    );
    const updated = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    if (error.code === '23514') {
      return res.status(400).json({ error: 'Status inválido. Execute a migração: server/migrate-requisicoes-status-fases.sql' });
    }
    console.error('Erro ao marcar como entregue:', error);
    res.status(500).json({ error: 'Erro ao marcar como entregue', details: error.message });
  }
});

// Deletar requisição
app.delete('/api/requisicoes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar se a requisição existe
    const checkReq = await pool.query('SELECT * FROM requisicoes WHERE id = $1', [id]);
    if (checkReq.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }

    // Deletar requisição (itens serão deletados automaticamente por CASCADE)
    await pool.query('DELETE FROM requisicoes WHERE id = $1', [id]);

    console.log(`✅ Requisição deletada: ID ${id}`);
    res.json({ message: 'Requisição deletada com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar requisição:', error);
    res.status(500).json({ error: 'Erro ao deletar requisição', details: error.message });
  }
});

// ============================================
// FIM DAS ROTAS DE REQUISIÇÕES
// ============================================

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`API disponível em http://localhost:${PORT}/api`);
}); 

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
}); 