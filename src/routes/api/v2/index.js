const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ success: true, version: 'v2', status: 'healthy', timestamp: new Date().toISOString() });
});

router.use(require('./rooms'));
router.use(require('./slideshows'));
router.use(require('./automations'));
router.use(require('./uploads'));
router.use(require('./themes'));
router.use(require('./system'));
router.use('/hooks', require('./hooks'));

// JSON 404 for unknown v2 endpoints
router.use((req, res) => {
  res.status(404).json({ success: false, error: `No API endpoint ${req.method} ${req.originalUrl}` });
});

module.exports = router;
