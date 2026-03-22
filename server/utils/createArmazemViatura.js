/**
 * Cria armazém tipo viatura com duas localizações: código (normal) e código.FERR.
 * Usado por POST /api/armazens e importação em lote.
 */
async function createArmazemViatura(pool, codigo, descricao) {
  const codigoNorm = String(codigo || '').trim().toUpperCase();
  const descricaoTrim = String(descricao || '').trim();
  if (!codigoNorm) {
    const e = new Error('Código é obrigatório');
    e.code = 'VALIDATION';
    throw e;
  }
  if (!descricaoTrim) {
    const e = new Error('Descrição é obrigatória');
    e.code = 'VALIDATION';
    throw e;
  }

  const locsWithTipo = [
    { localizacao: codigoNorm, tipo_localizacao: 'normal' },
    { localizacao: `${codigoNorm}.FERR`, tipo_localizacao: 'FERR' }
  ];

  let result;
  try {
    result = await pool.query(
      `
        INSERT INTO armazens (codigo, descricao, localizacao, tipo)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [codigoNorm, descricaoTrim, locsWithTipo[0].localizacao, 'viatura']
    );
  } catch (insertError) {
    if (insertError.code === '42703') {
      result = await pool.query(
        `
          INSERT INTO armazens (codigo, descricao, localizacao)
          VALUES ($1, $2, $3)
          RETURNING *
        `,
        [codigoNorm, descricaoTrim, locsWithTipo[0].localizacao]
      );
    } else {
      throw insertError;
    }
  }

  const armazemId = result.rows[0].id;
  let localizacoesSemTipo = false;

  try {
    for (const loc of locsWithTipo) {
      try {
        await pool.query(
          'INSERT INTO armazens_localizacoes (armazem_id, localizacao, tipo_localizacao) VALUES ($1, $2, $3)',
          [armazemId, loc.localizacao, loc.tipo_localizacao || 'normal']
        );
      } catch (insE) {
        if (insE.code === '42703') {
          await pool.query('INSERT INTO armazens_localizacoes (armazem_id, localizacao) VALUES ($1, $2)', [
            armazemId,
            loc.localizacao
          ]);
          localizacoesSemTipo = true;
        } else {
          throw insE;
        }
      }
    }
  } catch (e) {
    if (e.code === '42P01') {
      const err = new Error('Tabela armazens_localizacoes não existe');
      err.code = 'NO_LOC_TABLE';
      throw err;
    }
    throw e;
  }

  return {
    id: armazemId,
    codigo: codigoNorm,
    descricao: descricaoTrim,
    localizacoesSemTipo
  };
}

module.exports = { createArmazemViatura };
