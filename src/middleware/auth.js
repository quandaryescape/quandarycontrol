const crypto = require('crypto');

/**
 * Optional HTTP Basic auth for operator tools.
 *
 * Disabled unless ADMIN_PASSWORD is set. Player screens, slideshow playback,
 * inbound webhooks, hardware variable endpoints and static assets stay open so
 * props and TVs keep working without credentials.
 */
const PROTECTED_PAGES = [
  /^\/$/,
  /^\/admin(\.html)?$/,
  /^\/settings$/,
  /^\/theme-builder(\.html)?$/,
  /^\/room\/[^/]+\/(gm|rules-editor|slideshow-editor|automations)$/,
  /^\/(gm|rules-editor|slideshow-editor|automations|theme-builder|admin)\.html$/
];

function isProtectedApi(req) {
  const p = req.path;
  if (!p.startsWith('/api/v2/')) return false;
  if (p.startsWith('/api/v2/hooks/')) return false;
  // Public reads needed by player screens and slideshow playback
  if (req.method === 'GET' && (/^\/api\/v2\/rooms\/[^/]+\/slideshows$/.test(p) || /^\/api\/v2\/slideshows\/[^/]+$/.test(p) || /^\/api\/v2\/rooms\/[^/]+\/public$/.test(p))) {
    return false;
  }
  // Hardware-friendly variable setters stay open
  if (/^\/api\/v2\/rooms\/[^/]+\/variables\/[^/]+\/(set|increment|decrement|toggle)$/.test(p)) return false;
  return true;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function adminAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return next();

  const needsAuth = PROTECTED_PAGES.some(rx => rx.test(req.path)) || isProtectedApi(req);
  if (!needsAuth) return next();

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    const expectedUser = process.env.ADMIN_USER || 'admin';
    if (safeEqual(user, expectedUser) && safeEqual(pass, password)) return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Quandary Control", charset="UTF-8"');
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  return res.status(401).send('Authentication required');
}

module.exports = { adminAuth, isProtectedApi };
