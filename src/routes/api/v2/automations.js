const express = require('express');
const { asyncRoute, httpError, ok, requireRoom, services } = require('./helpers');

const router = express.Router();

function withUrls(req, automation) {
  if (!automation) return automation;
  const base = `${req.protocol}://${req.get('host')}`;
  return {
    ...automation,
    webhookUrl: automation.hook_key ? `${base}/api/hooks/${automation.hook_key}` : null
  };
}

router.get('/rooms/:id/automations', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  const { automationEngine } = services();
  automationEngine.invalidate(room.id);
  ok(res, automationEngine.list(room.id).map(a => withUrls(req, a)));
}));

router.post('/rooms/:id/automations', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  ok(res, withUrls(req, services().automationEngine.create(room.id, req.body || {})), 201);
}));

router.post('/rooms/:id/automations/reorder', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  ok(res, services().automationEngine.reorder(room.id, ids).map(a => withUrls(req, a)));
}));

router.get('/rooms/:id/automations/logs', asyncRoute(async (req, res) => {
  const room = requireRoom(req.params.id);
  ok(res, services().automationEngine.getLogs(room.id));
}));

router.get('/automations/:id', asyncRoute(async (req, res) => {
  const a = services().automationEngine.get(req.params.id);
  if (!a) throw httpError(404, 'Automation not found');
  ok(res, withUrls(req, a));
}));

router.put('/automations/:id', asyncRoute(async (req, res) => {
  const a = services().automationEngine.update(req.params.id, req.body || {});
  if (!a) throw httpError(404, 'Automation not found');
  ok(res, withUrls(req, a));
}));

router.delete('/automations/:id', asyncRoute(async (req, res) => {
  if (!services().automationEngine.remove(req.params.id)) throw httpError(404, 'Automation not found');
  ok(res, { id: req.params.id });
}));

router.post('/automations/:id/duplicate', asyncRoute(async (req, res) => {
  const { automationEngine } = services();
  const a = automationEngine.get(req.params.id);
  if (!a) throw httpError(404, 'Automation not found');
  const copy = automationEngine.create(a.room_id, { ...a, name: `${a.name} (copy)` });
  ok(res, withUrls(req, copy), 201);
}));

/** Run the actions right now, ignoring conditions and cooldown. */
router.post('/automations/:id/test', asyncRoute(async (req, res) => {
  const { automationEngine } = services();
  const a = automationEngine.get(req.params.id);
  if (!a) throw httpError(404, 'Automation not found');
  const run = automationEngine.runManual(a.room_id, a.id, { force: true, payload: (req.body && req.body.payload) || {} });
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 4000).unref());
  const result = await Promise.race([run, timeout]);
  if (!result) {
    run.catch(() => {});
    return ok(res, { ran: true, pending: true });
  }
  ok(res, result);
}));

router.post('/automations/:id/regenerate-hook', asyncRoute(async (req, res) => {
  const a = services().automationEngine.regenerateHookKey(req.params.id);
  if (!a) throw httpError(404, 'Automation not found');
  ok(res, withUrls(req, a));
}));

module.exports = router;
