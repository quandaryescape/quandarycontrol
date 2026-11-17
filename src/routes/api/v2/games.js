const express = require('express');
const { asyncRoute, httpError, ok, services } = require('./helpers');

/**
 * Game history (rows are created automatically by GameLogService).
 *   GET    /games?room=<id>&limit=50&offset=0   newest first, { items, total }
 *   PUT    /games/:id   { teamName, result: 'escaped' | 'failed' | null, notes }
 *   DELETE /games/:id
 */
const router = express.Router();

router.get('/games', asyncRoute(async (req, res) => {
  const { gameLog } = services();
  ok(res, gameLog.list({ roomId: req.query.room || undefined, limit: req.query.limit, offset: req.query.offset }));
}));

router.put('/games/:id', asyncRoute(async (req, res) => {
  const game = services().gameLog.update(req.params.id, req.body || {});
  if (!game) throw httpError(404, 'Game not found');
  ok(res, game);
}));

router.delete('/games/:id', asyncRoute(async (req, res) => {
  if (!services().gameLog.remove(req.params.id)) throw httpError(404, 'Game not found');
  ok(res, { id: req.params.id });
}));

module.exports = router;
