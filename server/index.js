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
const { uploadToGoogleDrive, getPublicUrl, deleteFromGoogleDrive } = require('./googleDriveConfig');

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
              importStatus[importId].erros.push({ codigo: codigo || 'N/A', descricao: nome || 'N/A', motivo: 'Código ou nome ausente', linha: idx + 2 });
              processados++;
              importStatus[importId].processados = processados;
              return;
            }
            const armazens = {};
            Object.keys(row).forEach(col => {
              if (col.startsWith('WH')) {
                armazens[col] = Number(row[col]) || 0;
              }
            });
            // UPSERT do item
            const upsertResult = await pool.query(`
              INSERT INTO itens (codigo, nome, descricao, categoria, quantidade, ordem_importacao)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (codigo) DO UPDATE
                SET nome = EXCLUDED.nome, descricao = EXCLUDED.descricao, quantidade = EXCLUDED.quantidade, ordem_importacao = EXCLUDED.ordem_importacao
              RETURNING id
            `, [codigo, nome, descricao, 'Importado', quantidade, ordem_importacao]);
            if (upsertResult && upsertResult.rows && upsertResult.rows.length > 0) {
              const itemId = upsertResult.rows[0].id;
              // Deletar armazéns antigos
              await pool.query('DELETE FROM armazens_item WHERE item_id = $1', [itemId]);
              // Inserir armazéns
              const armazemEntries = Object.entries(armazens);
              for (const [armazem, qtd] of armazemEntries) {
                await pool.query('INSERT INTO armazens_item (item_id, armazem, quantidade) VALUES ($1, $2, $3)', [itemId, armazem, qtd]);
              }
            } else {
              importStatus[importId].erros.push({ codigo: codigo, descricao: nome || 'N/A', motivo: 'Erro no UPSERT', erro: 'ID não retornado', linha: idx + 2 });
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

  pool.query('SELECT * FROM usuarios WHERE username = $1', [username], (err, result) => {
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
  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens,
           COUNT(DISTINCT img.id) as total_imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    GROUP BY i.id
    ORDER BY i.ordem_importacao ASC, i.data_cadastro DESC
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
            imagens: imagensResult.rows,
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
      unidadeArmazenamento: req.body.unidadeArmazenamento || ''
    };

    pool.query(`
      INSERT INTO itens (nome, descricao, categoria, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, setor, comprimento, largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING id
    `, [itemData.nome, itemData.descricao, itemData.categoria, itemData.codigo, itemData.preco, itemData.quantidade, itemData.localizacao, itemData.observacoes,
        itemData.familia, itemData.subfamilia, itemData.setor, itemData.comprimento, itemData.largura, itemData.altura, itemData.unidade, itemData.peso, itemData.unidadePeso, itemData.unidadeArmazenamento],
      (err, result) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const itemId = result.rows[0].id;

        // Salvar imagens no Google Drive
        if (req.files && req.files.length > 0) {
          const imagensPromises = req.files.map(async (file) => {
            try {
              // Upload para Google Drive
              const driveResult = await uploadToGoogleDrive(
                file.path, 
                `${itemId}_${Date.now()}_${file.originalname}`, 
                file.mimetype
              );
              
              // Tornar arquivo público e obter URL
              const publicUrl = await getPublicUrl(driveResult.fileId);
              
              // Salvar informações no banco
              return new Promise((resolve, reject) => {
                pool.query(`
                  INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo)
                  VALUES ($1, $2, $3, $4)
                `, [itemId, file.originalname, publicUrl, file.mimetype], (err) => {
                  if (err) reject(err);
                  else {
                    // Remover arquivo local após upload
                    fs.unlink(file.path, (unlinkErr) => {
                      if (unlinkErr) console.error('Erro ao remover arquivo local:', unlinkErr);
                    });
                    resolve();
                  }
                });
              });
            } catch (error) {
              console.error('Erro no upload para Google Drive:', error);
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
app.post('/api/reconhecer', upload.single('imagem'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhuma imagem enviada' });
  }

  // Algoritmo de reconhecimento por imagem
  // 1. Extrair características da imagem enviada
  // 2. Comparar com imagens existentes no banco
  // 3. Retornar itens mais similares
  
  // Por enquanto, vamos implementar uma busca inteligente
  // que analisa características básicas da imagem
  const imageAnalysis = {
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype,
    // Aqui você pode adicionar análise de cores, formas, etc.
  };

  // Buscar itens com base em características similares
  // Por enquanto, retornamos todos os itens ordenados por relevância
  const query = `
    SELECT i.*, 
           STRING_AGG(DISTINCT img.caminho, ',') as imagens,
           COUNT(DISTINCT img.id) as total_imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    GROUP BY i.id
    ORDER BY 
      CASE 
        WHEN i.categoria IN ('Eletrônicos', 'Tecnologia') THEN 1
        WHEN i.categoria IN ('Ferramentas', 'Equipamentos') THEN 2
        ELSE 3
      END,
      i.data_cadastro DESC
    LIMIT 15
  `;

  pool.query(query, [], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const itens = result.rows.map(row => ({
      ...row,
      imagens: row.imagens ? row.imagens.split(',') : [],
      relevancia: Math.random() * 100 // Simulação de relevância
    }));

    // Ordenar por relevância simulada
    itens.sort((a, b) => b.relevancia - a.relevancia);
    
    res.json({
      message: 'Análise de imagem concluída',
      resultados: itens.slice(0, 10), // Top 10 resultados
      imagem_analisada: req.file.filename,
      total_encontrados: itens.length,
      analise: imageAnalysis
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
    unidadeArmazenamento,
    especificacoes
  } = req.body;

  if (!codigo || !descricao) {
    return res.status(400).json({ error: 'Código e descrição são obrigatórios' });
  }

  pool.query(`
    UPDATE itens 
    SET nome = $1, descricao = $2, categoria = $3, codigo = $4, preco = $5, quantidade = $6, localizacao = $7, observacoes = $8,
        familia = $9, subfamilia = $10, setor = $11, comprimento = $12, largura = $13, altura = $14,
        unidade = $15, peso = $16, unidadePeso = $17, unidadeArmazenamento = $18
    WHERE id = $19
  `, [
    nome || descricao, descricao, categoria || 'Sem categoria', codigo, preco, quantidade, localizacao, observacoes,
    familia, subfamilia, setor, comprimento, largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento, itemId
  ], (err, result) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
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

// Deletar item (protegido)
app.delete('/api/itens/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem excluir itens.' });
  }
  const itemId = req.params.id;

  // Primeiro, deletar imagens do sistema de arquivos
  pool.query('SELECT caminho FROM imagens_itens WHERE item_id = $1', [itemId], (err, imagensResult) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Deletar arquivos físicos
    imagensResult.rows.forEach(img => {
      const filePath = path.join(__dirname, '..', 'uploads', img.caminho);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    // Deletar do banco de dados
    pool.query('DELETE FROM itens WHERE id = $1', [itemId], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Item não encontrado' });
      }
      
      res.json({ message: 'Item deletado com sucesso' });
    });
  });
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
    const driveResult = await uploadToGoogleDrive(
      req.file.path,
      `test_${Date.now()}_${req.file.originalname}`,
      req.file.mimetype
    );

    console.log('Upload bem-sucedido:', driveResult);

    // Tornar arquivo público
    const publicUrl = await getPublicUrl(driveResult.fileId);
    console.log('URL pública:', publicUrl);

    // Remover arquivo local
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Erro ao remover arquivo local:', err);
    });

    res.json({
      message: 'Teste de upload bem-sucedido!',
      fileId: driveResult.fileId,
      publicUrl: publicUrl,
      webViewLink: driveResult.webViewLink
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`API disponível em http://localhost:${PORT}/api`);
}); 

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
}); 
