const express = require('express');
const XLSX = require('xlsx');

/**
 * TRFL/TRA/CLOG/Reporte e export Excel de requisição.
 * Fase 3: rotas adicionais podem migrar-se aqui a partir de requisicoes.js.
 */
function createDocumentosRouter(deps) {
  const {
    pool,
    requisicaoAuth,
    denyOperador,
    requisicaoArmazemOrigemAcessoPermitido,
    SQL_CRIADOR_NOME,
    attachSeriaisToRequisicaoItens,
  } = deps;

  const router = express.Router();

  router.get('/:id/export-excel', ...requisicaoAuth, denyOperador, async (req, res) => {
    try {
      const { id } = req.params;

      let reqResult;
      try {
        reqResult = await pool.query(
          `
        SELECT r.*,
          a.codigo as armazem_destino_codigo,
          a.tipo AS armazem_destino_tipo,
          ao.codigo as armazem_origem_codigo,
          ao.tipo AS armazem_origem_tipo,
          (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
          (COALESCE(ao.codigo, '') || CASE WHEN ao.codigo IS NOT NULL AND ao.codigo <> '' THEN ' - ' ELSE '' END || ao.descricao) as armazem_origem_descricao,
          ${SQL_CRIADOR_NOME} AS usuario_nome
        FROM requisicoes r
        INNER JOIN armazens a ON r.armazem_id = a.id
        LEFT JOIN armazens ao ON r.armazem_origem_id = ao.id
        LEFT JOIN usuarios u ON r.usuario_id = u.id
        WHERE r.id = $1
      `,
          [id]
        );
      } catch (qErr) {
        if (qErr.code === '42703') {
          reqResult = await pool.query(
            `
          SELECT r.*,
            a.codigo as armazem_destino_codigo,
            (COALESCE(a.codigo, '') || CASE WHEN a.codigo IS NOT NULL AND a.codigo <> '' THEN ' - ' ELSE '' END || a.descricao) as armazem_descricao,
            ${SQL_CRIADOR_NOME} AS usuario_nome
          FROM requisicoes r
          INNER JOIN armazens a ON r.armazem_id = a.id
          LEFT JOIN usuarios u ON r.usuario_id = u.id
          WHERE r.id = $1
        `,
            [id]
          );
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
      if (!requisicaoArmazemOrigemAcessoPermitido(req, requisicao.armazem_origem_id, { requisicao })) {
        return res.status(403).json({ error: 'Sem acesso a esta requisição.' });
      }
      const itensResult = await pool.query(
        `
      SELECT ri.*, i.codigo as item_codigo, i.descricao as item_descricao,
        i.familia as item_familia, i.subfamilia as item_subfamilia
      FROM requisicoes_itens ri
      INNER JOIN itens i ON ri.item_id = i.id
      WHERE ri.requisicao_id = $1
      ORDER BY ri.id
    `,
        [id]
      );
      requisicao.itens = itensResult.rows;
      await attachSeriaisToRequisicaoItens(pool, requisicao.itens);

      const dataFormat = new Date(requisicao.created_at);
      const dateStr = `${String(dataFormat.getDate()).padStart(2, '0')}/${String(dataFormat.getMonth() + 1).padStart(2, '0')}/${dataFormat.getFullYear()}`;
      const codigoOrigem = requisicao.armazem_origem_codigo || '';
      const codigoDestino = requisicao.armazem_destino_codigo || '';

      const rows = (requisicao.itens || [])
        .map((ri) => {
          const qtyBase =
            ri.quantidade_preparada !== null && ri.quantidade_preparada !== undefined
              ? ri.quantidade_preparada
              : ri.quantidade;
          const qty = parseInt(qtyBase, 10) || 0;
          if (qty <= 0) return null;
          return {
            Date: dateStr,
            OriginWarehouse: codigoOrigem,
            OriginLocation: ri.localizacao_origem || '',
            Article: String(ri.item_codigo || ''),
            Quatity: qty,
            SerialNumber1: '',
            SerialNumber2: '',
            MacAddress: '',
            CentroCusto: '',
            DestinationWarehouse: codigoDestino,
            DestinationLocation: ri.localizacao_destino || codigoDestino,
            ProjectCode: '',
            Batch: '',
          };
        })
        .filter(Boolean);

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(
        rows.length
          ? rows
          : [
              {
                Date: '',
                OriginWarehouse: '',
                OriginLocation: '',
                Article: '',
                Quatity: '',
                SerialNumber1: '',
                SerialNumber2: '',
                MacAddress: '',
                CentroCusto: '',
                DestinationWarehouse: '',
                DestinationLocation: '',
                ProjectCode: '',
                Batch: '',
              },
            ],
        {
          header: [
            'Date',
            'OriginWarehouse',
            'OriginLocation',
            'Article',
            'Quatity',
            'SerialNumber1',
            'SerialNumber2',
            'MacAddress',
            'CentroCusto',
            'DestinationWarehouse',
            'DestinationLocation',
            'ProjectCode',
            'Batch',
          ],
        }
      );

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

  return router;
}

module.exports = { createDocumentosRouter };
