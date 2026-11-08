const express = require('express');
const os = require('os');
const ai = require('../../../services/ai-service');
const settings = require('../../../services/settings-service');
const { asyncRoute, httpError, ok } = require('./helpers');
const pkg = require('../../../../package.json');

const router = express.Router();

/** LAN addresses so the admin can show player links/QR codes that work on other devices. */
function lanAddresses(port) {
  const out = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal && !/^169\.254\./.test(iface.address)) {
        out.push({ interface: name, url: `http://${iface.address}${port && port !== '80' ? `:${port}` : ''}` });
      }
    }
  }
  return out;
}

router.get('/system/info', asyncRoute(async (req, res) => {
  const host = req.get('host') || '';
  const port = host.includes(':') ? host.split(':').pop() : (process.env.PORT || '3000');
  ok(res, {
    version: pkg.version,
    node: process.version,
    origin: `${req.protocol}://${host}`,
    lan: lanAddresses(port),
    adminProtected: !!process.env.ADMIN_PASSWORD,
    ai: ai.status()
  });
}));

router.get('/settings', asyncRoute(async (req, res) => {
  ok(res, {
    ai: ai.status(),
    publicUrl: settings.get('public_url') || ''
  });
}));

router.put('/settings', asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (body.ai && typeof body.ai === 'object') {
    if (body.ai.apiKey !== undefined) {
      const key = String(body.ai.apiKey || '').trim();
      if (key && !/^[\w-]{20,200}$/.test(key)) throw httpError(400, 'That does not look like an OpenRouter API key');
      settings.set('openrouter_api_key', key || null);
    }
    if (body.ai.model !== undefined) {
      const model = String(body.ai.model || '').trim();
      if (model && !/^[\w.\-/:]{2,120}$/.test(model)) throw httpError(400, 'Invalid model id');
      settings.set('openrouter_model', model || null);
    }
  }
  if (body.publicUrl !== undefined) {
    const url = String(body.publicUrl || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw httpError(400, 'Public URL must start with http:// or https://');
    settings.set('public_url', url || null);
  }
  ok(res, { ai: ai.status(), publicUrl: settings.get('public_url') || '' });
}));

router.post('/settings/ai/test', asyncRoute(async (req, res) => {
  const key = String((req.body && req.body.apiKey) || ai.getApiKey() || '').trim();
  if (!key) throw httpError(400, 'No API key to test');
  const info = await ai.testKey(key);
  ok(res, { label: info.label || null, usage: info.usage ?? null, limit: info.limit ?? null, isFreeTier: info.is_free_tier ?? null });
}));

router.get('/ai/models', asyncRoute(async (req, res) => {
  const models = await ai.listModels({ force: req.query.refresh === '1' });
  ok(res, { models, recommended: ai.pickDefaultModel(models), selected: ai.status().model });
}));

router.post('/ai/theme', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const result = await ai.editTheme({
    instruction: body.instruction,
    html: String(body.html || ''),
    css: String(body.css || ''),
    js: String(body.js || ''),
    history: body.history,
    selection: body.selection,
    roomName: body.roomName,
    model: body.model
  });
  ok(res, result);
}));

module.exports = router;
