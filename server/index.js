const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
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

// Endpoint para importar Excel (apenas admin)
const excelUpload = multer({ dest: 'uploads/' });
app.post('/api/importar-excel', authenticateToken, excelUpload.single('arquivo'), (req, res) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem importar dados.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado.' });
  }
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    // Início da transação
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      data.forEach((row, idx) => {
        const codigo = row['Artigo']?.toString().trim();
        const descricao = row['Descrição']?.toString().trim();
        const nome = descricao; // Usar descrição como nome
        const quantidade = Number(row['TOTAL']) || 0;
        const ordem_importacao = idx;
        if (!codigo || !nome) {
          console.log(`[IMPORTAÇÃO] Linha ${idx + 2}: Código ou nome ausente. Ignorado.`);
          return;
        }
        // Montar objeto de armazéns
        const armazens = {};
        Object.keys(row).forEach(col => {
          if (col.startsWith('WH')) {
            armazens[col] = Number(row[col]) || 0;
          }
        });
        // Logar armazéns importados
        console.log(`[IMPORTAÇÃO] Item ${codigo} - Armazéns:`);
        Object.entries(armazens).forEach(([armazem, qtd]) => {
          console.log(`  - ${armazem}: ${qtd}`);
        });
        db.get('SELECT id FROM itens WHERE codigo = ?', [codigo], (err, item) => {
          if (err) {
            console.error(`[IMPORTAÇÃO] Erro ao buscar item (${codigo}):`, err.message);
            return;
          }
          const upsertArmazens = (itemId) => {
            // Apaga armazéns antigos desse item
            db.run('DELETE FROM armazens_item WHERE item_id = ?', [itemId], (err) => {
              if (err) {
                console.error(`[IMPORTAÇÃO] Erro ao limpar armazéns do item (${codigo}):`, err.message);
              } else {
                // Batch insert dos armazéns
                const armazemEntries = Object.entries(armazens);
                if (armazemEntries.length > 0) {
                  const values = armazemEntries.map(([armazem, qtd]) => `(${itemId}, '${armazem.replace(/'/g, "''")}', ${qtd})`).join(',');
                  db.run(`INSERT INTO armazens_item (item_id, armazem, quantidade) VALUES ${values}`);
                }
              }
            });
          };
          if (item) {
            db.run('UPDATE itens SET nome = ?, descricao = ?, quantidade = ?, ordem_importacao = ? WHERE id = ?', [nome, descricao, quantidade, ordem_importacao, item.id], function(err2) {
              if (err2) {
                console.error(`[IMPORTAÇÃO] Erro ao atualizar item (${codigo}):`, err2.message);
              } else {
                upsertArmazens(item.id);
                console.log(`[IMPORTAÇÃO] Item atualizado: ${codigo}`);
              }
            });
          } else {
            db.run('INSERT INTO itens (codigo, nome, descricao, categoria, quantidade, ordem_importacao) VALUES (?, ?, ?, ?, ?, ?)', [codigo, nome, descricao, 'Importado', quantidade, ordem_importacao], function(err2) {
              if (err2) {
                console.error(`[IMPORTAÇÃO] Erro ao inserir item (${codigo}):`, err2.message);
              } else {
                upsertArmazens(this.lastID);
              }
            });
          }
        });
      });
      db.run('COMMIT');
    });
    fs.unlinkSync(req.file.path);
    res.json({ message: 'Importação concluída com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao processar o arquivo.' });
  }
});

// Inicialização do banco de dados
const db = new sqlite3.Database('catalogo.db');

// Criar tabelas
db.serialize(() => {
  // Tabela de itens
  db.run(`CREATE TABLE IF NOT EXISTS itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    data_cadastro DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabela de armazéns por item
  db.run(`CREATE TABLE IF NOT EXISTS armazens_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    armazem TEXT,
    quantidade INTEGER,
    FOREIGN KEY (item_id) REFERENCES itens(id) ON DELETE CASCADE
  )`);

  // Tabela de imagens dos itens
  db.run(`CREATE TABLE IF NOT EXISTS imagens_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    nome_arquivo TEXT NOT NULL,
    caminho TEXT NOT NULL,
    tipo TEXT,
    data_upload DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (item_id) REFERENCES itens (id) ON DELETE CASCADE
  )`);

  // Tabela de especificações dos itens
  db.run(`CREATE TABLE IF NOT EXISTS especificacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    nome_especificacao TEXT NOT NULL,
    valor TEXT NOT NULL,
    obrigatorio BOOLEAN DEFAULT 0,
    FOREIGN KEY (item_id) REFERENCES itens (id) ON DELETE CASCADE
  )`);

  // Tabela de usuários
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nome TEXT NOT NULL,
    email TEXT UNIQUE,
    role TEXT DEFAULT 'admin',
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Criar usuário admin padrão se não existir
  db.get('SELECT id FROM usuarios WHERE username = ?', ['admin'], (err, row) => {
    if (err) {
      console.error('Erro ao verificar usuário admin:', err);
      return;
    }
    
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run('INSERT INTO usuarios (username, password, nome, email, role) VALUES (?, ?, ?, ?, ?)',
        ['admin', hashedPassword, 'Administrador', 'admin@catalogo.com', 'admin'],
        (err) => {
          if (err) {
            console.error('Erro ao criar usuário admin:', err);
          } else {
            console.log('Usuário admin criado com sucesso!');
            console.log('Username: admin');
            console.log('Password: admin123');
          }
        }
      );
    }
  });

  // Adicionar campo ordem_importacao se não existir
  // (executa apenas uma vez, ignora erro se já existir)
  db.run('ALTER TABLE itens ADD COLUMN ordem_importacao INTEGER', [], (err) => {
    if (err && !err.message.includes('duplicate')) {
      console.error('Erro ao adicionar coluna ordem_importacao:', err.message);
    }
  });
});

// Rotas da API

// Autenticação
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username e password são obrigatórios' });
  }

  db.get('SELECT * FROM usuarios WHERE username = ?', [username], (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

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
           GROUP_CONCAT(DISTINCT img.caminho) as imagens,
           COUNT(DISTINCT img.id) as total_imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    GROUP BY i.id
    ORDER BY i.ordem_importacao ASC, i.data_cadastro DESC
  `;

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const itens = rows.map(row => ({
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
  db.get('SELECT * FROM itens WHERE id = ?', [itemId], (err, item) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!item) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }
    
    // Buscar imagens
    db.all('SELECT * FROM imagens_itens WHERE item_id = ?', [itemId], (err, imagens) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      // Buscar especificações
      db.all('SELECT * FROM especificacoes WHERE item_id = ?', [itemId], (err, especificacoes) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        // Buscar armazéns
        db.all('SELECT armazem, quantidade FROM armazens_item WHERE item_id = ?', [itemId], (err, armazens) => {
          if (err) {
            return res.status(500).json({ error: err.message });
          }
          res.json({
            ...item,
            imagens: imagens,
            especificacoes: especificacoes,
            armazens: armazens || []
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
    marca,
    modelo,
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
    db.get('SELECT id FROM itens WHERE codigo = ?', [codigo], (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      if (row) {
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
      marca,
      modelo,
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

    db.run(`
      INSERT INTO itens (nome, descricao, categoria, marca, modelo, codigo, preco, quantidade, localizacao, observacoes, familia, subfamilia, setor, comprimento, largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [itemData.nome, itemData.descricao, itemData.categoria, itemData.marca, itemData.modelo, 
        itemData.codigo, itemData.preco, itemData.quantidade, itemData.localizacao, itemData.observacoes,
        itemData.familia, itemData.subfamilia, itemData.setor, itemData.comprimento, itemData.largura, itemData.altura, itemData.unidade, itemData.peso, itemData.unidadePeso, itemData.unidadeArmazenamento],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const itemId = this.lastID;

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
                db.run(`
                  INSERT INTO imagens_itens (item_id, nome_arquivo, caminho, tipo)
                  VALUES (?, ?, ?, ?)
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
                    db.run(`
                      INSERT INTO especificacoes (item_id, nome_especificacao, valor, obrigatorio)
                      VALUES (?, ?, ?, ?)
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
           GROUP_CONCAT(DISTINCT img.caminho) as imagens,
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

  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const itens = rows.map(row => ({
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
           GROUP_CONCAT(DISTINCT img.caminho) as imagens
    FROM itens i
    LEFT JOIN imagens_itens img ON i.id = img.item_id
    WHERE i.nome LIKE ? OR i.descricao LIKE ? OR i.categoria LIKE ? OR i.marca LIKE ? OR i.modelo LIKE ?
    GROUP BY i.id
    ORDER BY i.data_cadastro DESC
  `;

  const searchTerm = `%${q}%`;
  
  db.all(query, [searchTerm, searchTerm, searchTerm, searchTerm, searchTerm], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const itens = rows.map(row => ({
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
    marca,
    modelo,
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

  db.run(`
    UPDATE itens 
    SET nome = ?, descricao = ?, categoria = ?, marca = ?, modelo = ?, 
        codigo = ?, preco = ?, quantidade = ?, localizacao = ?, observacoes = ?,
        familia = ?, subfamilia = ?, setor = ?, comprimento = ?, largura = ?, altura = ?,
        unidade = ?, peso = ?, unidadePeso = ?, unidadeArmazenamento = ?
    WHERE id = ?
  `, [
    nome || descricao, descricao, categoria || 'Sem categoria', marca, modelo, codigo, preco, quantidade, localizacao, observacoes,
    familia, subfamilia, setor, comprimento, largura, altura, unidade, peso, unidadePeso, unidadeArmazenamento, itemId
  ], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    // Atualizar especificações se enviadas
    if (especificacoes) {
      try {
        const especArray = JSON.parse(especificacoes);
        // Apagar especificações antigas
        db.run('DELETE FROM especificacoes WHERE item_id = ?', [itemId], (err) => {
          if (err) {
            return res.status(500).json({ error: 'Erro ao apagar especificações antigas.' });
          }
          // Inserir novas especificações
          const especPromises = especArray.map(espec => {
            return new Promise((resolve, reject) => {
              db.run(`
                INSERT INTO especificacoes (item_id, nome_especificacao, valor, obrigatorio)
                VALUES (?, ?, ?, ?)
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
  db.all('SELECT caminho FROM imagens_itens WHERE item_id = ?', [itemId], (err, imagens) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Deletar arquivos físicos
    imagens.forEach(img => {
      const filePath = path.join(__dirname, '..', 'uploads', img.caminho);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });

    // Deletar do banco de dados
    db.run('DELETE FROM itens WHERE id = ?', [itemId], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (this.changes === 0) {
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
  db.serialize(() => {
    db.run('DELETE FROM armazens_item', [], (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao apagar armazéns.' });
      db.run('DELETE FROM imagens_itens', [], (err2) => {
        if (err2) return res.status(500).json({ error: 'Erro ao apagar imagens.' });
        db.run('DELETE FROM especificacoes', [], (err3) => {
          if (err3) return res.status(500).json({ error: 'Erro ao apagar especificações.' });
          db.run('DELETE FROM itens', [], (err4) => {
            if (err4) return res.status(500).json({ error: 'Erro ao apagar itens.' });
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

  db.get('SELECT caminho FROM imagens_itens WHERE id = ?', [imagemId], (err, imagem) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    if (!imagem) {
      return res.status(404).json({ error: 'Imagem não encontrada' });
    }

    // Deletar arquivo físico
    const filePath = path.join(__dirname, '..', 'uploads', imagem.caminho);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Deletar do banco
    db.run('DELETE FROM imagens_itens WHERE id = ?', [imagemId], function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      res.json({ message: 'Imagem deletada com sucesso' });
    });
  });
});

// Obter categorias
app.get('/api/categorias', (req, res) => {
  db.all('SELECT DISTINCT categoria FROM itens ORDER BY categoria', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const categorias = rows.map(row => row.categoria);
    res.json(categorias);
  });
});

// Estatísticas
app.get('/api/estatisticas', (req, res) => {
  const stats = {};
  
  // Total de itens
  db.get('SELECT COUNT(*) as total FROM itens', [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    stats.totalItens = row.total;
    
    // Total de categorias
    db.get('SELECT COUNT(DISTINCT categoria) as total FROM itens', [], (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      stats.totalCategorias = row.total;
      
      // Total de imagens
      db.get('SELECT COUNT(*) as total FROM imagens_itens', [], (err, row) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        stats.totalImagens = row.total;
        
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`API disponível em http://localhost:${PORT}/api`);
}); 