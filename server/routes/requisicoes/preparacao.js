const express = require('express');
const { isFluxoDevolucaoViaturaCentral } = require('../../middleware/requisicoesScope');
const { usuarioTemPermissaoControloStock } = require('../../utils/usuarioDbColumns');
const { isAdmin } = require('../../utils/roles');

const SQL_CRIADOR_NOME = `COALESCE(
  NULLIF(TRIM(CONCAT(COALESCE(u.nome, ''), ' ', COALESCE(u.sobrenome, ''))), ''),
  NULLIF(TRIM(COALESCE(u.username, '')), ''),
  NULLIF(TRIM(COALESCE(u.numero_colaborador::text, '')), ''),
  '—'
)`;

function createPreparacaoRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    denyBackofficeOperations,
    requisicaoArmazemOrigemAcessoPermitido,
    hasRecebimentoMarker,
    separadorImpedeAcao,
    respostaBloqueioSeparador,
    adminPodeCorrigirPreparacaoItemSeparada,
    adminPodeRemoverLinhaRequisicao,
    reservarMetrosStockLote,
    liberarMetrosStockLotePorRequisicaoItem,
    liberarReservasLotePorRequisicaoItem,
    logStockMovimento,
    quantidadeNecessariaStockPreparacao,
    isTipoControloSerial,
    serialsNormalizadosList,
    obterCompartilhaStockSerialArmazem,
    armazemControlaSerialNumbers,
    attachSeriaisToRequisicaoItens,
    caixaPorSerialFromSerialnumberBlob,
    getRequisicaoComItens,
    schedulePersistMovimentosHistoricoForRequisicoes,
    movimentosHistoricoTableExists,
    STOCK_STATUS,
    makeStockPrepBizError,
    localizacaoArmazemPorTipoConn,
    LOCALIZACAO_RECEBIMENTO_FALLBACK,
  } = deps;
  const router = express.Router();

router.patch('/:id/atender-item', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      requisicao_item_id,
      quantidade_preparada,
      quantidade_apeados,
      localizacao_origem,
      localizacao_destino,
      lote,
      serialnumber,
      bobinas,
      serials,
    } = req.body;

    if (!requisicao_item_id || quantidade_preparada === undefined) {
      return res.status(400).json({ error: 'requisicao_item_id e quantidade_preparada são obrigatórios (use 0 se não tiver o item).' });
    }
    const quantidadePreparadaRaw = Number(quantidade_preparada);
    if (!Number.isFinite(quantidadePreparadaRaw)) {
      return res.status(400).json({ error: 'quantidade_preparada deve ser numérica (use 0 se não tiver o item).' });
    }
    const prepComBobinasLote = Array.isArray(bobinas) && bobinas.length > 0;
    if (!prepComBobinasLote && !Number.isInteger(quantidadePreparadaRaw)) {
      return res.status(400).json({ error: 'quantidade_preparada deve ser um inteiro.' });
    }
    if (quantidadePreparadaRaw < 0) {
      return res.status(400).json({ error: 'quantidade_preparada não pode ser negativo.' });
    }
    const quantidadePreparadaFinal = Math.max(0, quantidadePreparadaRaw);
    const isZero = quantidadePreparadaFinal === 0;
    const locOrigem = typeof localizacao_origem === 'string' ? localizacao_origem.trim() : '';
    await client.query('BEGIN');
    let check;
    let hasSeparadorUsuarioColumn = true;
    try {
      check = await client.query(
        `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
                ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
         FROM requisicoes r
         LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
         INNER JOIN armazens a ON r.armazem_id = a.id
         WHERE r.id = $1 FOR UPDATE OF r`,
        [id]
      );
    } catch (lockErr) {
      if (
        lockErr.code === '42703'
        && String(lockErr.message || '').includes('separador_usuario_id')
      ) {
        hasSeparadorUsuarioColumn = false;
        check = await client.query(
          `SELECT r.id, r.status, r.observacoes, r.armazem_origem_id, r.armazem_id,
                  ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
           FROM requisicoes r
           LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
           INNER JOIN armazens a ON r.armazem_id = a.id
           WHERE r.id = $1 FOR UPDATE OF r`,
          [id]
        );
      } else {
        await client.query('ROLLBACK');
        throw lockErr;
      }
    }

    if (check.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const stReq = String(check.rows[0].status || '');
    const ehRecebimentoTransfer = hasRecebimentoMarker(check.rows[0]);
    if (!isZero && !ehRecebimentoTransfer && !locOrigem) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Localização de saída (onde está saindo) é obrigatória quando há quantidade preparada.' });
    }
    if (stReq === 'cancelada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Requisição cancelada' });
    }
    const podeAlterarPreparacao =
      ['pendente', 'EM SEPARACAO'].includes(stReq) ||
      adminPodeCorrigirPreparacaoItemSeparada(stReq, req.user && req.user.role);
    if (!podeAlterarPreparacao) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error:
          'Não é possível alterar a preparação após a requisição estar separada ou em fase posterior (expedição, entrega, etc.). Administradores podem corrigir linhas só em Separadas ou Em expedição.',
        code: 'PREPARACAO_ENCERRADA',
      });
    }

    if (hasSeparadorUsuarioColumn && separadorImpedeAcao(check.rows[0], req)) {
      await client.query('ROLLBACK');
      return respostaBloqueioSeparador(res);
    }

    const itemCheck = await client.query(
      `SELECT ri.*, i.tipocontrolo, i.codigo AS item_codigo,
        EXISTS (
          SELECT 1 FROM itens_setores is2
          WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
        ) AS is_ferramenta
       FROM requisicoes_itens ri
       INNER JOIN itens i ON ri.item_id = i.id
       WHERE ri.id = $1 AND ri.requisicao_id = $2`,
      [requisicao_item_id, id]
    );
    if (itemCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado nesta requisição' });
    }
    const item = itemCheck.rows[0];
    const quantidadeApeadosOrigem = parseInt(item.quantidade_apeados ?? 0, 10) || 0;
    const qApeadosRaw = quantidade_apeados === undefined
      ? quantidadeApeadosOrigem
      : Number(quantidade_apeados);
    if (!Number.isFinite(qApeadosRaw)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quantidade_apeados deve ser numérico (use 0 se não tiver APEADOS).' });
    }
    if (!Number.isInteger(qApeadosRaw)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quantidade_apeados deve ser um inteiro.' });
    }
    if (qApeadosRaw < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'quantidade_apeados não pode ser negativo.' });
    }
    if (qApeadosRaw > quantidadePreparadaFinal) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'quantidade_apeados não pode ser superior à quantidade preparada.',
      });
    }
    const quantidadeApeadosFinal = isZero ? 0 : qApeadosRaw;
    const ehDevolucaoViaturaCentral = isFluxoDevolucaoViaturaCentral(
      check.rows[0].armazem_origem_tipo,
      check.rows[0].armazem_destino_tipo
    );

    if (!ehRecebimentoTransfer && !isZero && check.rows[0].armazem_origem_id && check.rows[0].armazem_id) {
      const tiposR = await client.query(
        `SELECT ao.tipo AS origem_tipo, ad.tipo AS dest_tipo, ao.codigo AS origem_codigo
         FROM armazens ao
         CROSS JOIN armazens ad
         WHERE ao.id = $1 AND ad.id = $2`,
        [check.rows[0].armazem_origem_id, check.rows[0].armazem_id]
      );
      const tr = tiposR.rows[0];
      if (tr && ehDevolucaoViaturaCentral) {
        const codV = String(tr.origem_codigo || '').trim().toUpperCase();
        const isFerr = item.is_ferramenta === true;
        const expected = isFerr ? `${codV}.FERR` : codV;
        const lo = locOrigem.trim().toUpperCase();
        if (lo !== expected) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: isFerr
              ? `Devolução da viatura: a localização de origem deste artigo (ferramenta) deve ser ${expected}.`
              : `Devolução da viatura: a localização de origem deste artigo deve ser ${expected} (não use ${codV}.FERR exceto para ferramentas).`
          });
        }
      }
    }

    // Validar Lote/Serial/Bobinas conforme tipo de controlo do item, apenas quando há saída
    const tipoControlo = (item.tipocontrolo || '').toUpperCase();
    let serialsNormalizados = null;
    if (!isZero && tipoControlo === 'LOTE' && Array.isArray(bobinas)) {
      if (bobinas.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item ${item.item_id} é controlado por LOTE. Informe pelo menos uma bobina.` });
      }
      const lotesNorm = bobinas
        .map((b) => String(b.lote || '').trim().toUpperCase())
        .filter(Boolean);
      const dupLotes = lotesNorm.filter((x, i) => lotesNorm.indexOf(x) !== i);
      if (dupLotes.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Lotes duplicados na mesma preparação: ${[...new Set(dupLotes)].join(', ')}.`,
        });
      }
      for (const b of bobinas) {
        const loteB = (b.lote || '').trim();
        const metros = Number(b.metros);
        if (!loteB || !metros || metros <= 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Toda bobina do item ${item.item_id} deve ter lote e metragem > 0.` });
        }
      }
    } else if (!isZero) {
      if (tipoControlo === 'LOTE' && (!lote || String(lote).trim() === '')) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item ${item.item_id} é controlado por LOTE. Informe o lote na preparação.` });
      }
      if (isTipoControloSerial(tipoControlo)) {
        if (Array.isArray(serials)) {
          serialsNormalizados = serialsNormalizadosList(serials.join('\n'));
          if (serialsNormalizados.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Item ${item.item_id} é controlado por número de série. Informe pelo menos um serial number.` });
          }
          const serialsUnicos = new Set(serialsNormalizados);
          if (serialsUnicos.size !== serialsNormalizados.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Item ${item.item_id} contém serial numbers duplicados. Remova os repetidos antes de confirmar.`
            });
          }
        } else if (!serialnumber || String(serialnumber).trim() === '') {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Item ${item.item_id} é controlado por número de série. Informe o Serial number na preparação.` });
        } else {
          serialsNormalizados = serialsNormalizadosList(serialnumber);
          if (serialsNormalizados.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Item ${item.item_id} é controlado por número de série. Informe o Serial number na preparação.` });
          }
        }
      }
    }

    let localizacaoDestinoFinal = null;
    if (!isZero) {
      if (ehRecebimentoTransfer) {
        localizacaoDestinoFinal =
          (await localizacaoArmazemPorTipoConn(client, check.rows[0].armazem_origem_id, 'recebimento')) ||
          LOCALIZACAO_RECEBIMENTO_FALLBACK;
      } else {
        // Fluxo normal: destino automático em expedição
        localizacaoDestinoFinal = 'EXPEDICAO';
      }
    }

    const serialnumberFinal = isZero
      ? null
      : isTipoControloSerial(tipoControlo)
        ? null
        : (serialsNormalizados ? serialsNormalizados.join('\n') : (serialnumber || null));

    const updateQuery =
      isTipoControloSerial(tipoControlo)
        ? `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, 
          localizacao_destino = $2, 
          localizacao_origem = $3, 
          lote = COALESCE($4, lote),
          serialnumber = $5,
          quantidade_apeados = $6,
          preparacao_confirmada = true
      WHERE id = $7`
        : `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, 
          localizacao_destino = $2, 
          localizacao_origem = $3, 
          lote = COALESCE($4, lote),
          serialnumber = COALESCE($5, serialnumber),
          quantidade_apeados = $6,
          preparacao_confirmada = true
      WHERE id = $7`;
    const updateQueryLegacy =
      isTipoControloSerial(tipoControlo)
        ? `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, 
          localizacao_destino = $2, 
          localizacao_origem = $3, 
          lote = COALESCE($4, lote),
          serialnumber = $5,
          quantidade_apeados = $6
      WHERE id = $7`
        : `
      UPDATE requisicoes_itens 
      SET quantidade_preparada = $1, 
          localizacao_destino = $2, 
          localizacao_origem = $3, 
          lote = COALESCE($4, lote),
          serialnumber = COALESCE($5, serialnumber),
          quantidade_apeados = $6
      WHERE id = $7`;
    const params = [
      quantidadePreparadaFinal,
      localizacaoDestinoFinal,
      isZero ? null : (ehRecebimentoTransfer ? null : locOrigem),
      isZero ? null : (lote || null),
      serialnumberFinal,
      quantidadeApeadosFinal,
      requisicao_item_id
    ];

    const needStockQty = quantidadeNecessariaStockPreparacao({
      isZero,
      tipoControlo,
      quantidadePreparadaFinal,
      bobinas: Array.isArray(bobinas) ? bobinas : [],
      serialsNormalizados,
    });

    try {
      if (!ehRecebimentoTransfer && usuarioTemPermissaoControloStock(req)) {
        await assertStockSuficientePreparacaoLocalizacao(client, {
          armazemOrigemId: check.rows[0].armazem_origem_id,
          itemId: item.item_id,
          itemCodigo: item.item_codigo || String(item.item_id),
          locLabel: isZero ? '' : locOrigem,
          needQty: needStockQty,
        });
      }

      const origemControlaRastreavel = await obterCompartilhaStockSerialArmazem(
        client,
        check.rows[0].armazem_origem_id,
        check.rows[0].armazem_origem_tipo
      );
      /** Saída de armazém central: exige coerência de serial/lote com `stock_*` e localização (não aplica a recebimento mercadoria nem a devolução viatura→central). */
      const validarSaidaRastreioCentral =
        String(check.rows[0].armazem_origem_tipo || '').trim().toLowerCase() === 'central'
        && !ehRecebimentoTransfer;

      if (tipoControlo === 'LOTE') {
        let moduloStockLote = false;
        try {
          await client.query('SELECT 1 FROM stock_lote WHERE false');
          moduloStockLote = true;
        } catch (eLt) {
          if (eLt.code !== '42P01') throw eLt;
        }

        // Libera reservas anteriores desta linha antes de recalcular a preparação atual.
        if (moduloStockLote) {
          await liberarReservasLotePorRequisicaoItem(client, {
            requisicaoItemId: requisicao_item_id,
            usuarioId: req.user?.id || null,
            origem: 'atender-item-recalculo',
          });
        }

        if (validarSaidaRastreioCentral && !isZero && moduloStockLote) {
            const labLote = String(locOrigem || '').trim();
            if (!labLote) {
              await client.query('ROLLBACK');
              return res.status(400).json({
                error: 'Localização de saída é obrigatória para validar lotes no armazém central.',
              });
            }
            const armLoteId = check.rows[0].armazem_origem_id;
            if (Array.isArray(bobinas) && bobinas.length > 0) {
              for (const b of bobinas) {
                const loteB = String(b.lote || '').trim();
                const metros = Number(b.metros) || 0;
                if (!loteB || metros <= 0) continue;
                // eslint-disable-next-line no-await-in-loop
                const dispR = await client.query(
                  `SELECT quantidade_disponivel::numeric AS q
                   FROM stock_lote
                   WHERE item_id = $1
                     AND armazem_id = $2
                     AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
                     AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
                  [item.item_id, armLoteId, labLote, loteB]
                );
                const disp = dispR.rows.length ? Number(dispR.rows[0].q) : 0;
                if (disp + 1e-9 < metros) {
                  throw makeStockPrepBizError(
                    400,
                    disp <= 0
                      ? `Lote «${loteB}» não existe na localização «${labLote}» do armazém central (saída).`
                      : `Lote «${loteB}» na localização «${labLote}» sem saldo disponível suficiente (disponível: ${disp}, necessário: ${metros}).`
                  );
                }
              }
            } else if (lote && String(lote).trim()) {
              const needL = Number(quantidadePreparadaFinal) || 0;
              const loteS = String(lote).trim();
              const dispR = await client.query(
                `SELECT quantidade_disponivel::numeric AS q
                 FROM stock_lote
                 WHERE item_id = $1
                   AND armazem_id = $2
                   AND UPPER(TRIM(localizacao)) = UPPER(TRIM($3::text))
                   AND UPPER(TRIM(lote)) = UPPER(TRIM($4::text))`,
                [item.item_id, armLoteId, labLote, loteS]
              );
              const disp = dispR.rows.length ? Number(dispR.rows[0].q) : 0;
              if (needL > 0 && disp + 1e-9 < needL) {
                throw makeStockPrepBizError(
                  400,
                  disp <= 0
                    ? `Lote «${loteS}» não existe na localização «${labLote}» do armazém central (saída).`
                    : `Lote «${loteS}» na localização «${labLote}» sem saldo disponível suficiente (disponível: ${disp}, necessário: ${needL}).`
                );
              }
            }
        }

        /** Reserva em stock_lote: central (validação rastreável) ou armazém com stock partilhado. */
        const deveReservarLote =
          !isZero
          && !ehDevolucaoViaturaCentral
          && moduloStockLote
          && (origemControlaRastreavel || validarSaidaRastreioCentral);
        if (deveReservarLote) {
          const reservaLoteBase = {
            itemId: item.item_id,
            armazemId: check.rows[0].armazem_origem_id,
            localizacao: locOrigem,
            requisicaoId: Number(id),
            requisicaoItemId: requisicao_item_id,
            usuarioId: req.user?.id || null,
          };
          if (Array.isArray(bobinas) && bobinas.length > 0) {
            for (const b of bobinas) {
              const loteB = String(b.lote || '').trim();
              const metros = Number(b.metros) || 0;
              if (!loteB || metros <= 0) continue;
              // eslint-disable-next-line no-await-in-loop
              await reservarMetrosStockLote(client, (mov) => logStockMovimento(mov), {
                ...reservaLoteBase,
                lote: loteB,
                metros,
              });
            }
          } else if (lote && String(lote).trim()) {
            const metrosUnico = Number(quantidadePreparadaFinal) || 0;
            if (metrosUnico > 0) {
              await reservarMetrosStockLote(client, (mov) => logStockMovimento(mov), {
                ...reservaLoteBase,
                lote: String(lote).trim(),
                metros: metrosUnico,
              });
            }
          }
        }
      }

      if (isTipoControloSerial(tipoControlo)) {
        await client.query(
          `UPDATE stock_serial
           SET status = 'disponivel',
               requisicao_id = NULL,
               requisicao_item_id = NULL,
               reservado_em = NULL,
               atualizado_em = CURRENT_TIMESTAMP
           WHERE requisicao_item_id = $1
             AND status = 'reservado'`,
          [requisicao_item_id]
        );

        if (!isZero && Array.isArray(serialsNormalizados) && serialsNormalizados.length > 0) {
          let moduloStockSerial = true;
          try {
            await client.query('SELECT 1 FROM stock_serial WHERE false');
          } catch (eTbl) {
            if (eTbl.code === '42P01') moduloStockSerial = false;
            else throw eTbl;
          }

          if (moduloStockSerial) {
            const locFiltroSerial = String(locOrigem || '').trim();
            const armOrigId = check.rows[0].armazem_origem_id;
            // Alinhado a `deveReservarLote`: central valida saída em stock_serial e deve reservar,
            // mesmo quando `compartilha_stock_serial` do armazém está desligado.
            const fazerReservaSerial =
              (origemControlaRastreavel || validarSaidaRastreioCentral)
              && !ehDevolucaoViaturaCentral;

            const sqlSerialComLoc =
              `SELECT id, serialnumber, status
               FROM stock_serial
               WHERE item_id = $1
                 AND armazem_id = $2
                 AND serialnumber = ANY($3::text[])
                 AND UPPER(TRIM(localizacao)) = UPPER(TRIM($4::text))
               ORDER BY serialnumber`;
            const sqlSerialSemLoc =
              `SELECT id, serialnumber, status
               FROM stock_serial
               WHERE item_id = $1
                 AND armazem_id = $2
                 AND serialnumber = ANY($3::text[])
               ORDER BY serialnumber`;
            const paramsSerialComLoc = [item.item_id, armOrigId, serialsNormalizados, locFiltroSerial];
            const paramsSerialSemLoc = [item.item_id, armOrigId, serialsNormalizados];

            const assertSerialRowsOk = (rows, exigeLocLabel) => {
              const rowsBySerial = new Map(
                (rows || []).map((row) => [String(row.serialnumber || '').trim(), row])
              );
              const emFalta = serialsNormalizados.filter((sn) => !rowsBySerial.has(sn));
              if (emFalta.length > 0) {
                throw makeStockPrepBizError(
                  400,
                  exigeLocLabel
                    ? `Os seguintes seriais não foram encontrados na localização «${exigeLocLabel}» do armazém de origem: ${emFalta.join(', ')}.`
                    : `Os seguintes seriais não foram encontrados no armazém de origem: ${emFalta.join(', ')}.`,
                  exigeLocLabel ? 'SERIAL_LOCALIZACAO_ORIGEM_INEXISTENTE' : undefined
                );
              }
              const indisponiveis = [];
              for (const sn of serialsNormalizados) {
                const row = rowsBySerial.get(sn);
                if (String(row.status) !== STOCK_STATUS.DISPONIVEL) {
                  indisponiveis.push(`${sn} (${row.status})`);
                }
              }
              if (indisponiveis.length > 0) {
                throw makeStockPrepBizError(
                  400,
                  validarSaidaRastreioCentral && !fazerReservaSerial
                    ? `Os seguintes seriais não estão disponíveis na origem (devem estar «disponivel»): ${indisponiveis.join(', ')}.`
                    : `Os seguintes seriais não estão disponíveis para reserva: ${indisponiveis.join(', ')}.`
                );
              }
              return rowsBySerial;
            };

            const precisaValidarSerialStock =
              validarSaidaRastreioCentral || (fazerReservaSerial && !ehRecebimentoTransfer);
            if (precisaValidarSerialStock) {
              if (validarSaidaRastreioCentral && !locFiltroSerial) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                  error: 'Localização de saída é obrigatória para validar seriais no armazém central.',
                });
              }
              const sqlSerial =
                validarSaidaRastreioCentral || locFiltroSerial ? sqlSerialComLoc : sqlSerialSemLoc;
              const paramsSerial =
                validarSaidaRastreioCentral || locFiltroSerial
                  ? paramsSerialComLoc
                  : paramsSerialSemLoc;
              const comLock = fazerReservaSerial && !ehRecebimentoTransfer;
              const serialQ = await client.query(
                comLock ? `${sqlSerial} FOR UPDATE` : sqlSerial,
                paramsSerial
              );
              const rowsLocked = assertSerialRowsOk(
                serialQ.rows,
                validarSaidaRastreioCentral || locFiltroSerial ? locFiltroSerial : null
              );

              if (comLock) {
                const serialIds = [...rowsLocked.values()]
                  .map((row) => Number(row.id))
                  .filter((n) => Number.isFinite(n) && n > 0);
                if (serialIds.length > 0) {
                  await client.query(
                    `UPDATE stock_serial
                     SET status = 'reservado',
                         requisicao_id = $1,
                         requisicao_item_id = $2,
                         reservado_em = CURRENT_TIMESTAMP,
                         atualizado_em = CURRENT_TIMESTAMP
                     WHERE id = ANY($3::int[])`,
                    [id, requisicao_item_id, serialIds]
                  );
                }
                await logStockMovimento({
                  db: client,
                  tipo: 'reserva_serial_preparacao',
                  itemId: item.item_id,
                  armazemId: armOrigId,
                  localizacao: locOrigem,
                  quantidade: serialsNormalizados.length,
                  requisicaoId: Number(id),
                  requisicaoItemId: requisicao_item_id,
                  usuarioId: req.user?.id || null,
                  payload: { serials: serialsNormalizados },
                });
              }
            }
          }
        }
      }

      if (isTipoControloSerial(tipoControlo)) {
        // Preservar codigo_caixa (ex.: recebimento com import COD+S/N+caixa) antes do DELETE+reINSERT.
        const caixaPorSerialUpper = new Map();
        try {
          const prevCx = await client.query(
            `SELECT serialnumber,
                    NULLIF(TRIM(COALESCE(codigo_caixa, '')), '') AS codigo_caixa
             FROM requisicoes_itens_seriais
             WHERE requisicao_item_id = $1`,
            [requisicao_item_id]
          );
          for (const r of prevCx.rows || []) {
            const k = String(r.serialnumber || '').trim().toUpperCase();
            const cx = r.codigo_caixa != null && String(r.codigo_caixa).trim() ? String(r.codigo_caixa).trim() : '';
            if (k && cx) caixaPorSerialUpper.set(k, cx);
          }
        } catch (eCx) {
          if (eCx.code !== '42703') throw eCx;
        }
        try {
          const riBlobRow = await client.query(
            `SELECT serialnumber FROM requisicoes_itens WHERE id = $1`,
            [requisicao_item_id]
          );
          const blob = riBlobRow.rows[0]?.serialnumber;
          if (blob) {
            for (const [k, v] of caixaPorSerialFromSerialnumberBlob(blob)) {
              if (v && !caixaPorSerialUpper.has(k)) caixaPorSerialUpper.set(k, v);
            }
          }
        } catch (_) {
          /* ignore */
        }

        await client.query('DELETE FROM requisicoes_itens_seriais WHERE requisicao_item_id = $1', [
          requisicao_item_id,
        ]);
        const serialsApeadosSelecionados = Array.isArray(req.body?.serials_apeados)
          ? [...new Set(req.body.serials_apeados.map((s) => String(s || '').trim()).filter(Boolean))]
          : [];
        const apeadoUpper = new Set(serialsApeadosSelecionados.map((s) => s.toUpperCase()));

        if (!isZero && Array.isArray(serialsNormalizados) && serialsNormalizados.length > 0) {
          const serialRowsJson = serialsNormalizados.map((rawSn, i) => {
            const sn = String(rawSn || '').trim();
            const k = sn.toUpperCase();
            const rowJ = { sn, ord: i + 1, apeado: apeadoUpper.has(k) };
            const cx = caixaPorSerialUpper.get(k);
            if (cx) rowJ.caixa = cx;
            return rowJ;
          });
          const payloadJson = JSON.stringify(serialRowsJson);

          await client.query('SAVEPOINT sp_insert_requisicoes_itens_seriais_apeado');
          try {
            await client.query(
              `INSERT INTO requisicoes_itens_seriais (requisicao_item_id, serialnumber, ordem, apeado, codigo_caixa)
               SELECT $1::int, (e->>'sn')::text, (e->>'ord')::int, (e->>'apeado')::boolean,
                      NULLIF(TRIM(e->>'caixa'), '')::text
               FROM jsonb_array_elements($2::jsonb) AS e`,
              [requisicao_item_id, payloadJson]
            );
            await client.query('RELEASE SAVEPOINT sp_insert_requisicoes_itens_seriais_apeado');
          } catch (eInsSerial) {
            await client.query('ROLLBACK TO SAVEPOINT sp_insert_requisicoes_itens_seriais_apeado');
            if (eInsSerial.code !== '42703') throw eInsSerial;
            try {
              await client.query(
                `INSERT INTO requisicoes_itens_seriais (requisicao_item_id, serialnumber, ordem, apeado)
                 SELECT $1::int, (e->>'sn')::text, (e->>'ord')::int, (e->>'apeado')::boolean
                 FROM jsonb_array_elements($2::jsonb) AS e`,
                [requisicao_item_id, payloadJson]
              );
              await client.query('RELEASE SAVEPOINT sp_insert_requisicoes_itens_seriais_apeado');
            } catch (e2) {
              await client.query('ROLLBACK TO SAVEPOINT sp_insert_requisicoes_itens_seriais_apeado');
              if (e2.code !== '42703') throw e2;
              await client.query(
                `INSERT INTO requisicoes_itens_seriais (requisicao_item_id, serialnumber, ordem)
                 SELECT $1::int, (e->>'sn')::text, (e->>'ord')::int
                 FROM jsonb_array_elements($2::jsonb) AS e`,
                [requisicao_item_id, payloadJson]
              );
              await client.query('RELEASE SAVEPOINT sp_insert_requisicoes_itens_seriais_apeado');
            }
          }
          const blobPrep = serialRowsJson
            .map((e) => (e.caixa ? `${e.sn}\t${e.caixa}` : e.sn))
            .join('\n');
          if (blobPrep) {
            await client.query(`UPDATE requisicoes_itens SET serialnumber = $2 WHERE id = $1`, [
              requisicao_item_id,
              blobPrep,
            ]);
          }
        }
      }

      try {
        await client.query(updateQuery, params);
      } catch (eUpdate) {
        if (
          eUpdate.code === '42703'
          && String(eUpdate.message || '').includes('preparacao_confirmada')
        ) {
          await client.query(updateQueryLegacy, params);
        } else {
          throw eUpdate;
        }
      }

      // Se houver bobinas para itens de lote e quantidade > 0, registrar detalhamento por bobina.
      // Se quantidade = 0, apagar qualquer detalhamento existente.
      if (tipoControlo === 'LOTE') {
        await client.query('DELETE FROM requisicoes_itens_bobinas WHERE requisicao_item_id = $1', [requisicao_item_id]);
        if (!isZero && Array.isArray(bobinas)) {
          for (const b of bobinas) {
            await client.query(
              `INSERT INTO requisicoes_itens_bobinas (requisicao_item_id, lote, serialnumber, metros, apeado)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                requisicao_item_id,
                (b.lote || '').trim(),
                (b.serialnumber || null),
                Number(b.metros),
                Boolean(b?.apeado),
              ]
            );
          }
        }
      }

      if (hasSeparadorUsuarioColumn) {
        await client.query(
          `UPDATE requisicoes SET
            separador_usuario_id = COALESCE(separador_usuario_id, $1),
            status = CASE WHEN status = 'pendente' THEN 'EM SEPARACAO' ELSE status END,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [req.user.id, id]
        );
      } else {
        await client.query(
          `UPDATE requisicoes SET
            status = CASE WHEN status = 'pendente' THEN 'EM SEPARACAO' ELSE status END,
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.isStockPrepBiz) {
        return res.status(e.status).json(e.payload);
      }
      if (e.code === '42703') {
        if (String(e.message || '').includes('separador_usuario_id')) {
          return res.status(503).json({
            error: 'Erro ao preparar item: coluna separador_usuario_id não existe no banco.',
            details: 'Execute a migração: npm run db:migrate:requisicoes-separador'
          });
        }
        const coluna = String(e.column || '').trim();
        const msg = String(e.message || '');
        const colunaMensagem = coluna || (msg.match(/column\s+"([^"]+)"/i)?.[1] || null);
        return res.status(503).json({
          error: colunaMensagem
            ? `Erro ao preparar item: coluna ${colunaMensagem} não existe no banco.`
            : 'Erro ao preparar item: coluna obrigatória não existe no banco.',
          details: `Execute as migrações pendentes (npm run db:migrate).${colunaMensagem ? ` Coluna em falta: ${colunaMensagem}.` : ''}`
        });
      }
      if (e.code === '42P01') {
        const msg = String(e.message || '');
        if (msg.includes('requisicoes_itens_seriais')) {
          return res.status(503).json({
            error: 'Tabela requisicoes_itens_seriais em falta na base de dados.',
            details: 'Execute a migração: npm run db:migrate:requisicoes-itens-seriais',
          });
        }
        return res.status(503).json({
          error: 'Estrutura de stock por localização em falta na base de dados.',
          details: 'Execute a migração: npm run db:migrate:localizacao-estoque'
        });
      }
      if (e.code === '23514' && e.constraint === 'requisicoes_status_check') {
        return res.status(503).json({
          error: 'Atualize o constraint de status das requisições (inclui EM SEPARACAO).',
          details: 'Execute: npm run db:migrate:em-separacao'
        });
      }
      throw e;
    }

    // Estado intermédio EM SEPARACAO é aplicado no UPDATE acima; 'separado' (Separadas) só via «Completar separação»
    const fullReq = await pool.query(`
      SELECT r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        ${SQL_CRIADOR_NOME} AS usuario_nome
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE r.id = $1
    `, [id]);
    const requisicao = fullReq.rows[0];
    const itensResult = await pool.query(
      `
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao, i.tipocontrolo,
        EXISTS (
          SELECT 1 FROM itens_setores is2
          WHERE is2.item_id = i.id AND UPPER(TRIM(is2.setor)) = 'FERRAMENTA'
        ) AS is_ferramenta
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `,
      [id]
    );
    let bobinasPorItem = {};
    try {
      const bobinasResult = await pool.query(
        `
        SELECT b.*, ri.item_id
        FROM requisicoes_itens_bobinas b
        INNER JOIN requisicoes_itens ri ON b.requisicao_item_id = ri.id
        WHERE ri.requisicao_id = $1
      `,
        [id]
      );
      for (const b of bobinasResult.rows || []) {
        if (!bobinasPorItem[b.item_id]) bobinasPorItem[b.item_id] = [];
        bobinasPorItem[b.item_id].push({
          id: b.id,
          lote: b.lote,
          serialnumber: b.serialnumber,
          metros: b.metros,
          apeado: b.apeado,
        });
      }
    } catch (_) {
      bobinasPorItem = {};
    }
    requisicao.itens = (itensResult.rows || []).map((it) => ({
      ...it,
      bobinas: bobinasPorItem[it.item_id] || [],
      preparacao_confirmada: it.preparacao_confirmada === true,
    }));
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);

    try {
      if (await movimentosHistoricoTableExists()) {
        schedulePersistMovimentosHistoricoForRequisicoes([Number(id)], 'atender-item');
      }
    } catch (eh) {
      console.warn('[movimentos_historico] falha ao agendar snapshot após atender-item:', eh.message);
    }

    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao preparar item:', error);
    res.status(500).json({ error: 'Erro ao preparar item', details: error.message });
  } finally {
    client.release();
  }
});

// Adicionar linha de item na requisição (fluxo de preparação; útil para correções em devolução)
router.post('/:id/requisicao-itens', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
  try {
    const requisicaoId = parseInt(req.params.id, 10);
    const itemId = parseInt(req.body?.item_id, 10);
    const quantidade = Number(req.body?.quantidade ?? 1);
    if (!Number.isFinite(requisicaoId) || !Number.isFinite(itemId)) {
      return res.status(400).json({ error: 'ID da requisição e item_id válidos são obrigatórios.' });
    }
    if (!Number.isFinite(quantidade) || quantidade < 0) {
      return res.status(400).json({ error: 'Quantidade inválida.' });
    }

    const check = await pool.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [requisicaoId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Requisição não encontrada.' });
    const reqRow = check.rows[0];
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, reqRow.armazem_origem_id, {
        requisicao: reqRow,
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(reqRow, req)) {
      return respostaBloqueioSeparador(res);
    }
    const st = String(reqRow.status || '');
    const podeAlterarPreparacao =
      ['pendente', 'EM SEPARACAO'].includes(st) ||
      adminPodeCorrigirPreparacaoItemSeparada(st, req.user && req.user.role);
    if (!podeAlterarPreparacao) {
      return res.status(400).json({
        error:
          'Só é possível adicionar artigos quando a requisição está em preparação (pendente/EM SEPARACAO) ou por administrador em Separadas/Em expedição.',
      });
    }

    const itemCheck = await pool.query(
      `SELECT id, codigo, descricao, tipocontrolo FROM itens WHERE id = $1`,
      [itemId]
    );
    if (!itemCheck.rows.length) {
      return res.status(404).json({ error: 'Item não encontrado.' });
    }
    const exists = await pool.query(
      `SELECT id FROM requisicoes_itens WHERE requisicao_id = $1 AND item_id = $2 LIMIT 1`,
      [requisicaoId, itemId]
    );
    if (exists.rows.length) {
      return res.status(400).json({ error: 'Este artigo já existe na requisição.' });
    }

    await pool.query(
      `INSERT INTO requisicoes_itens
         (requisicao_id, item_id, quantidade, quantidade_preparada, preparacao_confirmada)
       VALUES ($1, $2, $3, 0, false)`,
      [requisicaoId, itemId, quantidade]
    );

    const fullReq = await pool.query(
      `
      SELECT r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        ${SQL_CRIADOR_NOME} AS usuario_nome
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE r.id = $1
    `,
      [requisicaoId]
    );
    const requisicao = fullReq.rows[0];
    const itensResult = await pool.query(
      `
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao, i.tipocontrolo
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `,
      [requisicaoId]
    );
    requisicao.itens = (itensResult.rows || []).map((it) => ({
      ...it,
      preparacao_confirmada: it.preparacao_confirmada === true,
    }));
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);
    return res.status(201).json(requisicao);
  } catch (error) {
    console.error('Erro ao adicionar item na requisição:', error);
    return res.status(500).json({ error: 'Erro ao adicionar item na requisição', details: error.message });
  }
});

// Remover linha de requisição (só admin; pendente/EM SEPARACAO/separado/EM EXPEDICAO; mín. 2 linhas)
router.delete('/:id/requisicao-itens/:requisicaoItemId', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
  try {
    if (!isAdmin(req.user.role)) {
      return res.status(403).json({
        error: 'Apenas administradores podem remover itens desta requisição.',
        code: 'APENAS_ADMIN',
      });
    }
    const requisicaoId = parseInt(req.params.id, 10);
    const requisicaoItemId = parseInt(req.params.requisicaoItemId, 10);
    if (!Number.isFinite(requisicaoId) || !Number.isFinite(requisicaoItemId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const check = await pool.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [requisicaoId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    const st = String(check.rows[0].status || '');
    if (!adminPodeRemoverLinhaRequisicao(st, req.user.role)) {
      return res.status(400).json({
        error:
          'Só é possível remover linhas quando a requisição está pendente, em separação, separada ou em expedição (apenas administrador).',
        code: 'REMOCAO_LINHA_INVALIDA',
      });
    }

    const linha = await pool.query(
      'SELECT id FROM requisicoes_itens WHERE id = $1 AND requisicao_id = $2',
      [requisicaoItemId, requisicaoId]
    );
    if (linha.rows.length === 0) {
      return res.status(404).json({ error: 'Linha não encontrada nesta requisição' });
    }

    const cnt = await pool.query(
      'SELECT COUNT(*)::int AS c FROM requisicoes_itens WHERE requisicao_id = $1',
      [requisicaoId]
    );
    if ((cnt.rows[0]?.c || 0) <= 1) {
      return res.status(400).json({
        error: 'Não é possível remover o único item da requisição. Cancele ou edite a requisição por outro meio.',
      });
    }

    try {
      await liberarReservasLotePorRequisicaoItem(pool, {
        requisicaoItemId,
        usuarioId: req.user?.id || null,
        origem: 'remover-linha',
      });
      await pool.query('DELETE FROM requisicoes_itens_bobinas WHERE requisicao_item_id = $1', [requisicaoItemId]);
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }
    await pool.query('DELETE FROM requisicoes_itens WHERE id = $1 AND requisicao_id = $2', [requisicaoItemId, requisicaoId]);

    const fullReq = await pool.query(
      `
      SELECT r.*,
        (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
        (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
        ${SQL_CRIADOR_NOME} AS usuario_nome
      FROM requisicoes r
      INNER JOIN armazens a ON r.armazem_id = a.id
      LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
      LEFT JOIN usuarios u ON r.usuario_id = u.id
      WHERE r.id = $1
    `,
      [requisicaoId]
    );
    const requisicao = fullReq.rows[0];
    const itensResult = await pool.query(
      `
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao, i.tipocontrolo
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `,
      [requisicaoId]
    );
    requisicao.itens = (itensResult.rows || []).map((it) => ({
      ...it,
      preparacao_confirmada: it.preparacao_confirmada === true,
    }));
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);

    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao remover linha da requisição:', error);
    res.status(500).json({ error: 'Erro ao remover linha', details: error.message });
  }
});

// Atender requisição (marcar como separado e opcionalmente preencher localização) — legado/alternativo
router.patch('/:id/atender', ...requisicaoAuth, denyBackofficeOperations, async (req, res) => {
  try {
    const { id } = req.params;
    const { localizacao } = req.body;

    const check = await pool.query(
      `SELECT r.id, r.status, r.armazem_origem_id, r.armazem_id, r.separador_usuario_id,
              ao.tipo AS armazem_origem_tipo, a.tipo AS armazem_destino_tipo
       FROM requisicoes r
       LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
       INNER JOIN armazens a ON r.armazem_id = a.id
       WHERE r.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Requisição não encontrada' });
    }
    if (
      !requisicaoArmazemOrigemAcessoPermitido(req, check.rows[0].armazem_origem_id, {
        requisicao: check.rows[0],
      })
    ) {
      return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
    }
    if (separadorImpedeAcao(check.rows[0], req)) {
      return respostaBloqueioSeparador(res);
    }
    if (['EM SEPARACAO', 'separado', 'EM EXPEDICAO', 'APEADOS', 'Entregue'].includes(check.rows[0].status)) {
      if (check.rows[0].status === 'EM SEPARACAO') {
        return res.status(400).json({
          error: 'A requisição está em separação. Use a página Preparar e «Concluir preparação da requisição» quando todos os itens estiverem confirmados.'
        });
      }
      return res.status(400).json({ error: 'Requisição já foi preparada' });
    }
    if (check.rows[0].status === 'cancelada') {
      return res.status(400).json({ error: 'Requisição cancelada' });
    }

    await pool.query(
      `
      UPDATE requisicoes 
      SET status = 'separado',
          localizacao = COALESCE($2, localizacao),
          separador_usuario_id = COALESCE(separador_usuario_id, $3),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
      [id, localizacao || null, req.user.id]
    );

    let result;
    try {
      result = await pool.query(`
        SELECT r.*,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          ${SQL_CRIADOR_NOME} AS usuario_nome
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
            ${SQL_CRIADOR_NOME} AS usuario_nome
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
    await attachSeriaisToRequisicaoItens(pool, requisicao.itens);

    console.log(`✅ Requisição marcada como separado: ID ${id}`);
    res.json(requisicao);
  } catch (error) {
    console.error('Erro ao atender requisição:', error);
    res.status(500).json({ error: 'Erro ao atender requisição', details: error.message });
  }
});


  return router;
}

module.exports = { createPreparacaoRouter };
