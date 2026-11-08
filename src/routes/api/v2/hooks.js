const express = require('express');
const { getServices } = require('../../../services/registry');

const router = express.Router();

/**
 * Inbound webhooks: any GET or POST to /api/hooks/:key runs that automation.
 * Query-string and JSON/form body fields are available in templates as {{payload.field}}.
 */
router.all('/:key', async (req, res) => {
  if (!['GET', 'POST', 'PUT'].includes(req.method)) {
    return res.status(405).json({ success: false, error: 'Use GET or POST' });
  }
  const services = getServices();
  if (!services) return res.status(503).json({ success: false, error: 'Server is starting' });
  const payload = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  try {
    const run = services.automationEngine.runWebhook(req.params.key, payload);
    // Don't keep a microcontroller waiting on long "delay" actions
    const timeout = new Promise(resolve => setTimeout(() => resolve(null), 3000).unref());
    const outcome = await Promise.race([run, timeout]);
    if (!outcome) {
      run.catch(() => {});
      return res.status(202).json({ success: true, accepted: true, ran: true, note: 'Actions are still running' });
    }
    const { automation, result } = outcome;
    res.json({
      success: true,
      automation: automation.name,
      ran: result.ran,
      reason: result.reason || null
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;
