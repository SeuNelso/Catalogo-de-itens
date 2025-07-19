require('dotenv').config();
/*
-- SCRIPT DE CRIAÇÃO DAS TABELAS NO POSTGRESQL (use no Railway Console ou cliente SQL)

CREATE TABLE itens (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  categoria TEXT NOT NULL,
  marca TEXT,
  modelo TEXT,
  codigo TEXT UNIQUE,
  preco REAL,
  quantidade INTEGER DEFAULT 0,
  localizacao TEXT,
  observacoes TEXT,
  familia TEXT,
  subfamilia TEXT,
  setor TEXT,
  comprimento REAL,
  largura REAL,
  altura REAL,
  unidade TEXT,
  peso TEXT,
  unidadePeso TEXT,
  unidadeArmazenamento TEXT,
  data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE armazens_item (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  armazem TEXT,
  quantidade INTEGER
);

CREATE TABLE imagens_itens (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  nome_arquivo TEXT NOT NULL,
  caminho TEXT NOT NULL,
  tipo TEXT,
  data_upload TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE especificacoes (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES itens(id) ON DELETE CASCADE,
  nome_especificacao TEXT NOT NULL,
  valor TEXT NOT NULL,
  obrigatorio BOOLEAN DEFAULT FALSE
);

CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  nome TEXT NOT NULL,
  email TEXT UNIQUE,
  role TEXT DEFAULT 'admin',
  data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
*/
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
// Remover ou comentar a linha abaixo após migração completa:
// const sqlite3 = require('sqlite3').verbose();
// const db = new sqlite3.Database('catalogo.db');

// Conexão com PostgreSQL (Railway)
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgres://postgres:DwAOpLGFNCgDcBkeobQVKuXqHWpiQqZt@switchyard.proxy.rlwy.net:10773/railway',
  ssl: { rejectUnauthorized: false }
});
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const { uploadToS3 } = require('./s3Upload');
const vision = require('@google-cloud/vision');
const { detectLabelsFromS3 } = require('./rekognition');
const AWS = require('aws-sdk');

const app = express();
const PORT = process.env.PORT || 5000;
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

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));
app.use(express.static(path.join(__dirname, '../client/build')));

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
  console.log('Recebendo importação de excel');
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem importar dados.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
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
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
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
              importStatus[importId].erros.push({ codigo: codigo || 'N/A', descricao: nome || 'N/A', motivo: 'Artigo não cadastrado', linha: idx + 2 });
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
              importStatus[importId].erros.push({ codigo: codigo, descricao: nome || 'N/A', motivo: 'Artigo não cadastrado', linha: idx + 2, armazens });
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
            importStatus[importId].erros.push({ codigo: row['Artigo'] || 'N/A', descricao: row['Descrição'] || 'N/A', motivo: 'Erro ao importar', erro: err?.message || String(err), linha: idx + 2 });
            processados++;
            importStatus[importId].processados = processados;
          }
        }));
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

// Endpoint para consultar status da importação
app.get('/api/importar-excel-status/:id', authenticateToken, (req, res) => {
  const importId = req.params.id;
  if (!importStatus[importId]) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }
  res.json(importStatus[importId]);
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
          // Inserir novo item
          const result = await pool.query(
            `INSERT INTO itens (nome, descricao, categoria, codigo, quantidade) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [nome, descricao, categoria, codigo, quantidade]
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
      return res.status(500).json({ error: err.message });
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    const user = result.rows[0];
    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: {
        id: user.id,
        username: user.username,
        nome: user.nome,
        role: user.role
      }
    });
  });
});

// Verificar token
app.get('/api/verify-token', authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Listar todos os itens (público) SEM paginação
app.get('/api/itens', (req, res) => {
  const incluirInativos = req.query.incluirInativos === 'true';
  const whereAtivo = incluirInativos ? '' : 'WHERE i.ativo = true';
  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens,
           COUNT(DISTINCT img.id) as total_imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    ${whereAtivo}
    GROUP BY i.id
    ORDER BY 
      (i.codigo ~ '^[0-9]') DESC, -- Prioriza códigos que começam com número
      i.codigo ASC,
      i.ordem_importacao ASC, 
      i.data_cadastro DESC
  `;

  pool.query(query, [], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const itens = result.rows.map(row => ({
      ...row,
      imagens: row.imagens ? row.imagens.split(',') : []
    }));
    res.json({ itens, total: itens.length });
  });
});

// Buscar item por ID
app.get('/api/itens/:id', (req, res) => {
  const itemId = req.params.id;
  
  // Buscar item
  pool.query('SELECT * FROM itens WHERE id = $1', [itemId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    // Buscar imagens
    pool.query('SELECT * FROM imagens_itens WHERE item_id = $1', [itemId], (err, imagensResult) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      // Buscar especificações
      pool.query('SELECT * FROM especificacoes WHERE item_id = $1', [itemId], (err, especificacoesResult) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        // Buscar armazéns
        pool.query('SELECT armazem, quantidade FROM armazens_item WHERE item_id = $1', [itemId], (err, armazensResult) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          res.json({
            ...result.rows[0],
            imagens: imagensResult.rows.map(img => ({
              id: img.id,
              caminho: img.caminho.startsWith('http')
                ? img.caminho
                : `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${img.caminho}`,
              nome_arquivo: img.nome_arquivo,
              tipo: img.tipo
            })),
            especificacoes: especificacoesResult.rows,
            armazens: armazensResult.rows || []
          });
        });
      });
    });
  });
});

// Cadastrar novo item (protegido)
app.post('/api/itens', authenticateToken, upload.array('imagens', 10), (req, res) => {
  const {
    nome,
    descricao,
    categoria,
    codigo,
    preco,
    quantidade,
    localizacao,
    observacoes,
    especificacoes
  } = req.body;

  // Validações obrigatórias
  if (!codigo || !descricao) {
    return res.status(400).json({ error: 'Código e descrição são obrigatórios' });
  }

  // Verificar se código já existe
  if (codigo) {
    pool.query('SELECT id FROM itens WHERE codigo = $1', [codigo], (err, result) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (result.rows.length > 0) {
        return res.status(400).json({ error: 'Código já existe' });
      }
      inserirItem();
    });
  } else {
    inserirItem();
  }

  function inserirItem() {
    // Concatenar peso e unidadePeso se ambos existirem
    let pesoFinal = '';
    if (req.body.peso && req.body.unidadePeso) {
      pesoFinal = `${req.body.peso} ${req.body.unidadePeso}`;
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
      unidadePeso: req.body.unidadePeso || '',
      unidadearmazenamento: req.body.unidadeArmazenamento || '',
      ativo: true // Sempre ativo ao cadastrar
    };

    pool.query(`
      INSERT INTO itens (nome, descricao, categoria, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, setor, comprimento, largura, altura, unidade, peso, unidadePeso, unidadearmazenamento, ativo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING id
    `, [itemData.nome, itemData.descricao, itemData.categoria, itemData.codigo, itemData.preco, itemData.quantidade, itemData.localizacao, itemData.observacoes,
        itemData.familia, itemData.subfamilia, itemData.setor, itemData.comprimento, itemData.largura, itemData.altura, itemData.unidade, itemData.peso, itemData.unidadePeso, itemData.unidadearmazenamento, itemData.ativo],
      (err, result) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const itemId = result.rows[0].id;

        // Salvar imagens no AWS S3
        if (req.files && req.files.length > 0) {
          const imagensPromises = req.files.map(async (file) => {
            try {
              // Upload para AWS S3
              const s3Result = await uploadToS3(
                file.path,
                `${itemId}_${Date.now()}_${file.originalname}`,
                file.mimetype
              );
              // Salvar informações no banco
              return new Promise((resolve, reject) => {
                pool.query(
                  `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo)
                   VALUES ($1, $2, $3, $4)`,
                  [itemId, file.originalname, s3Result.url, file.mimetype],
                  (err) => {
                    if (err) reject(err);
                    else {
                      // Remover arquivo local após upload
                      fs.unlink(file.path, (unlinkErr) => {});
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

          Promise.all(imagensPromises).then(() => {
            // Salvar especificações
            if (especificacoes) {
              try {
                const especArray = JSON.parse(especificacoes);
                const especPromises = especArray.map(espec => {
                  return new Promise((resolve, reject) => {
                    pool.query(`
                      INSERT INTO especificacoes (item_id, nome_especificacao, valor, obrigatorio)
                      VALUES ($1, $2, $3, $4)
                    `, [itemId, espec.nome, espec.valor, espec.obrigatorio ? 1 : 0], (err) => {
                      if (err) reject(err);
                      else resolve();
                    });
                  });
                });

                Promise.all(especPromises).then(() => {
                  res.status(201).json({ 
                    message: 'Item cadastrado com sucesso',
                    itemId: itemId 
                  });
                }).catch(err => {
                  res.status(500).json({ error: err.message });
                });
              } catch (err) {
                res.status(400).json({ error: 'Formato de especificações inválido' });
              }
            } else {
              res.status(201).json({ 
                message: 'Item cadastrado com sucesso',
                itemId: itemId 
              });
            }
          }).catch(err => {
            res.status(500).json({ error: err.message });
          });
        } else {
          res.status(201).json({ 
            message: 'Item cadastrado com sucesso',
            itemId: itemId 
          });
        }
      });
  }
});

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
app.put('/api/itens/:id', authenticateToken, upload.array('imagens', 10), (req, res) => {
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
    unidadePeso,
    unidadearmazenamento,
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
        familia = $9, subfamilia = $10, setor = $11, comprimento = $12, largura = $13, altura = $14,
        unidade = $15, peso = $16, unidadePeso = $17, unidadearmazenamento = $18
    WHERE id = $19
  `, [
    nome || descricao, descricao, categoria || 'Sem categoria', codigo, precoNum, quantidadeNum, localizacao, observacoes,
    familia, subfamilia, setor, comprimentoNum, larguraNum, alturaNum, unidade, peso, unidadePeso, unidadearmazenamento, itemId
  ], async (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    // Remover imagens marcadas para exclusão
    if (req.body.imagensRemovidas) {
      try {
        const imagensRemovidas = JSON.parse(req.body.imagensRemovidas);
        for (const imgId of imagensRemovidas) {
          // Buscar caminho da imagem
          const { rows } = await pool.query('SELECT caminho FROM imagens_itens WHERE id = $1 AND item_id = $2', [imgId, itemId]);
          if (rows.length > 0) {
            let key = rows[0].caminho;
            // Se for URL completa, extrair apenas o nome do arquivo
            if (key.startsWith('http')) {
              const url = new URL(key);
              key = decodeURIComponent(url.pathname.replace(/^\//, ''));
            }
            await deleteFromS3(key);
            await pool.query('DELETE FROM imagens_itens WHERE id = $1', [imgId]);
          }
        }
      } catch (err) {
        return res.status(500).json({ error: 'Erro ao remover imagens: ' + err.message });
      }
    }

    // Salvar novas imagens, se enviadas
    console.log('req.files:', req.files);
    console.log('req.file:', req.file);
    let arquivos = [];
    if (req.files && req.files.length > 0) {
      arquivos = req.files;
    } else if (req.file) {
      arquivos = [req.file];
    }
    console.log('Arquivos para upload:', arquivos.length);
    if (arquivos.length > 0) {
      try {
        const imagensPromises = arquivos.map(async (file) => {
          // Upload para AWS S3
          const s3Result = await uploadToS3(
            file.path,
            `${itemId}_${Date.now()}_${file.originalname}`,
            file.mimetype
          );
          // Salvar informações no banco
          await pool.query(
            `INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo)
             VALUES ($1, $2, $3, $4)`,
            [itemId, file.originalname, s3Result.url, file.mimetype]
          );
          // Remover arquivo local após upload
          fs.unlink(file.path, (unlinkErr) => {});
        });
        await Promise.all(imagensPromises);
      } catch (err) {
        console.error('Erro ao salvar imagens:', err);
        return res.status(500).json({ error: 'Erro ao salvar imagens: ' + err.message });
      }
    }

    // Atualizar especificações se enviadas
    if (especificacoes) {
      try {
        const especArray = JSON.parse(especificacoes);
        // Apagar especificações antigas
        pool.query('DELETE FROM especificacoes WHERE item_id = $1', [itemId], (err) => {
          if (err) {
            return res.status(500).json({ error: 'Erro ao apagar especificações antigas.' });
          }
          // Inserir novas especificações
          const especPromises = especArray.map(espec => {
            return new Promise((resolve, reject) => {
              pool.query(`
                INSERT INTO especificacoes (item_id, nome_especificacao, valor, obrigatorio)
                VALUES ($1, $2, $3, $4)
              `, [itemId, espec.nome, espec.valor, espec.obrigatorio ? 1 : 0], (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
          });
          Promise.all(especPromises).then(() => {
            res.json({ message: 'Item atualizado com sucesso' });
          }).catch(err => {
            res.status(500).json({ error: err.message });
          });
        });
      } catch (err) {
        return res.status(400).json({ error: 'Formato de especificações inválido' });
      }
    } else {
      res.json({ message: 'Item atualizado com sucesso' });
    }
  });
});

// Função para deletar imagem do S3
async function deleteFromS3(key) {
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
  });
  return new Promise((resolve, reject) => {
    s3.deleteObject({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
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
    await pool.query('DELETE FROM especificacoes WHERE item_id = $1', [itemId]);
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
        pool.query('DELETE FROM especificacoes', [], (err3) => {
          if (err3) {
            console.error('Erro ao apagar especificações:', err3.message);
            return res.status(500).json({ error: 'Erro ao apagar especificações.' });
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
      SELECT codigo, descricao, unidadearmazenamento, familia, subfamilia, setor, ativo, quantidade 
      FROM itens 
      WHERE ativo = true
      ORDER BY codigo
    `);
    
    if (!itens.length) {
      return res.status(404).json({ error: 'Nenhum item encontrado.' });
    }
    
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Itens');
    
    // Definir cabeçalhos
    worksheet.columns = [
      { header: 'Código', key: 'codigo', width: 12 },
      { header: 'Descrição', key: 'descricao', width: 40 },
      { header: 'Unidade base', key: 'unidade_base', width: 16 },
      { header: 'Família', key: 'familia', width: 18 },
      { header: 'Subfamília', key: 'subfamilia', width: 18 },
      { header: 'Setor', key: 'setor', width: 18 },
      { header: 'Ativo', key: 'ativo', width: 8 },
      { header: 'Quantidade', key: 'quantidade', width: 12 }
    ];
    
    // Adicionar dados
    itens.forEach(item => {
      worksheet.addRow({
        codigo: item.codigo,
        descricao: item.descricao,
        unidade_base: item.unidadearmazenamento,
        familia: item.familia,
        subfamilia: item.subfamilia,
        setor: item.setor,
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
    const bucket = process.env.AWS_S3_BUCKET;
    const labels = await detectLabelsFromS3(bucket, key);
    res.json({ labels });
  } catch (error) {
    console.error('Erro no Rekognition:', error);
    res.status(500).json({ error: 'Erro ao analisar imagem no Rekognition.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`API disponível em http://localhost:${PORT}/api`);
}); 

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
}); 