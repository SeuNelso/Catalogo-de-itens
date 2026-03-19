/**
 * Coloca um utilizador existente num id numérico à escolha (troca com quem ocupava esse id).
 * Atualiza requisicoes.usuario_id e usuario_requisicoes_armazens.
 *
 * Variáveis de ambiente:
 *   ID_DESTINO        — id desejado (omissão: 1). Ex.: 13
 *   USUARIO_MIGRAR    — username OU nome completo (nome + sobrenome). Ex.: "Pablo Batistella"
 *   USUARIO_PARA_ID1  — (legado) se usar sem USUARIO_MIGRAR, username aqui; ID_DESTINO continua 1 por omissão
 *
 * Exemplos (raiz do projeto, com server/.env):
 *   ID_DESTINO=13 USUARIO_MIGRAR="Pablo Batistella" node server/run-usuario-para-id1.js
 *   npm run db:migrate:usuario-id1
 *
 * Depois da migração: faça logout/login para renovar o JWT.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// CLI: node server/run-usuario-para-id1.js --dest 13 --user "Pablo Batistella"
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dest' && argv[i + 1]) {
    process.env.ID_DESTINO = argv[++i];
  } else if ((argv[i] === '--user' || argv[i] === '-u') && argv[i + 1]) {
    process.env.USUARIO_MIGRAR = argv[++i];
  }
}

const ID_DESTINO = parseInt(
  process.env.ID_DESTINO || process.env.USUARIO_ID_DESTINO || '1',
  10
);
const USUARIO_MIGRAR = (
  process.env.USUARIO_MIGRAR ||
  process.env.USUARIO_PARA_ID1 ||
  'felipe.andrade'
).trim();

if (!ID_DESTINO || ID_DESTINO < 1) {
  console.error('ID_DESTINO inválido.');
  process.exit(1);
}

const connectionString =
  process.env.DATABASE_URL ||
  `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
});

function placeholderUsername(destId) {
  return `__migracao_reserva_id_${destId}__`;
}

async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return r.rows.length > 0;
}

async function findUsuario(client, search) {
  const r = await client.query(
    `SELECT id, username, nome, sobrenome FROM usuarios
     WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
        OR LOWER(TRIM(CONCAT(COALESCE(nome,''), ' ', COALESCE(sobrenome,'')))) = LOWER(TRIM($1))
        OR LOWER(TRIM(nome)) = LOWER(TRIM($1))`,
    [search]
  );
  if (r.rows.length > 1) {
    throw new Error(
      `Vários utilizadores correspondem a "${search}". Use o username exacto na variável USUARIO_MIGRAR.\n` +
        r.rows.map((x) => `  id=${x.id} username=${x.username} nome=${x.nome} ${x.sobrenome || ''}`).join('\n')
    );
  }
  if (!r.rows.length) {
    throw new Error(`Utilizador não encontrado: "${search}" (username ou nome completo).`);
  }
  return r.rows[0];
}

async function run() {
  const client = await pool.connect();
  const destId = ID_DESTINO;
  const phUser = placeholderUsername(destId);

  try {
    await client.query('BEGIN');

    const row = await findUsuario(client, USUARIO_MIGRAR);
    const srcId = row.id;

    if (srcId === destId) {
      await client.query('COMMIT');
      console.log(
        `"${USUARIO_MIGRAR}" (id ${srcId}, user ${row.username}) já está no id ${destId}. Nada a fazer.`
      );
      return;
    }

    const maxR = await client.query('SELECT COALESCE(MAX(id), 0) AS m FROM usuarios');
    const tempId = Number(maxR.rows[0].m) + 100000;

    let atDest = await client.query('SELECT id, username FROM usuarios WHERE id = $1', [destId]);
    let insertedPlaceholder = false;

    if (!atDest.rows.length) {
      const hash = bcrypt.hashSync('__sem_login_migracao__', 10);
      await client.query(
        `INSERT INTO usuarios (id, username, nome, password, role)
         VALUES ($1, $2, $3, $4, 'usuario')`,
        [destId, phUser, 'Reservado migração', hash]
      );
      insertedPlaceholder = true;
      await client.query(
        `SELECT setval(pg_get_serial_sequence('usuarios', 'id'), (SELECT MAX(id) FROM usuarios))`
      );
      atDest = await client.query('SELECT id, username FROM usuarios WHERE id = $1', [destId]);
    }

    const hasJunc = await tableExists(client, 'usuario_requisicoes_armazens');
    const hasReq = await tableExists(client, 'requisicoes');

    const reqIdsUser = async (uid) => {
      if (!hasReq) return [];
      const r = await client.query('SELECT id FROM requisicoes WHERE usuario_id = $1', [uid]);
      return r.rows.map((x) => x.id);
    };

    const juncRows = async (uid) => {
      if (!hasJunc) return [];
      const res = await client.query(
        'SELECT armazem_id FROM usuario_requisicoes_armazens WHERE usuario_id = $1',
        [uid]
      );
      return res.rows.map((x) => x.armazem_id);
    };

    const idsReqDest = await reqIdsUser(destId);
    const idsReqSrc = await reqIdsUser(srcId);
    const armDest = await juncRows(destId);
    const armSrc = await juncRows(srcId);

    if (hasJunc) {
      await client.query('DELETE FROM usuario_requisicoes_armazens WHERE usuario_id IN ($1, $2)', [
        destId,
        srcId
      ]);
    }
    if (hasReq) {
      await client.query('UPDATE requisicoes SET usuario_id = NULL WHERE usuario_id IN ($1, $2)', [
        destId,
        srcId
      ]);
    }

    await client.query('UPDATE usuarios SET id = $1 WHERE id = $2', [tempId, destId]);
    await client.query('UPDATE usuarios SET id = $1 WHERE id = $2', [destId, srcId]);
    await client.query('UPDATE usuarios SET id = $1 WHERE id = $2', [srcId, tempId]);

    if (hasReq) {
      if (idsReqDest.length) {
        await client.query('UPDATE requisicoes SET usuario_id = $1 WHERE id = ANY($2::int[])', [
          srcId,
          idsReqDest
        ]);
      }
      if (idsReqSrc.length) {
        await client.query('UPDATE requisicoes SET usuario_id = $1 WHERE id = ANY($2::int[])', [
          destId,
          idsReqSrc
        ]);
      }
    }

    if (hasJunc) {
      for (const aid of armDest) {
        await client.query(
          `INSERT INTO usuario_requisicoes_armazens (usuario_id, armazem_id) VALUES ($1, $2)
           ON CONFLICT (usuario_id, armazem_id) DO NOTHING`,
          [srcId, aid]
        );
      }
      for (const aid of armSrc) {
        await client.query(
          `INSERT INTO usuario_requisicoes_armazens (usuario_id, armazem_id) VALUES ($1, $2)
           ON CONFLICT (usuario_id, armazem_id) DO NOTHING`,
          [destId, aid]
        );
      }
    }

    if (insertedPlaceholder) {
      const atSrcSlot = await client.query(
        'SELECT id FROM usuarios WHERE id = $1 AND username = $2',
        [srcId, phUser]
      );
      if (atSrcSlot.rows.length) {
        if (hasJunc) {
          await client.query('DELETE FROM usuario_requisicoes_armazens WHERE usuario_id = $1', [srcId]);
        }
        await client.query('DELETE FROM usuarios WHERE id = $1', [srcId]);
      }
    }

    await client.query(
      `SELECT setval(pg_get_serial_sequence('usuarios', 'id'), (SELECT COALESCE(MAX(id), 1) FROM usuarios))`
    );

    await client.query('COMMIT');

    const label =
      row.username && USUARIO_MIGRAR.toLowerCase() !== row.username.toLowerCase()
        ? `${USUARIO_MIGRAR} (@${row.username})`
        : USUARIO_MIGRAR;

    console.log(
      `Concluído: ${label} passou a ter id=${destId}. Quem ocupava id=${destId} ficou com id=${srcId}.`
    );
    if (insertedPlaceholder) {
      console.log(`(Placeholder criado e removido para reservar id=${destId} durante a troca.)`);
    }
    console.log('Faça logout e volte a entrar para refrescar o token JWT se necessário.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erro:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
