const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) { /* exists */ }

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 750;

// Uploaded files are served from our own origin, so never accept anything a
// browser would execute (html, js, etc.).
const BLOCKED_EXTENSIONS = new Set(['.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.php', '.exe', '.bat', '.cmd', '.sh', '.ps1', '.dll', '.msi', '.jar', '.svgz']);
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'font/'];
const ALLOWED_EXTRA_MIME = new Set(['application/pdf', 'application/font-woff', 'application/x-font-ttf', 'application/vnd.ms-fontobject', 'application/octet-stream']);

function isAllowed(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'image/svg+xml') return true; // served with nosniff; theme logos often use SVG
  if (ALLOWED_MIME_PREFIXES.some(p => mime.startsWith(p))) return true;
  if (ALLOWED_EXTRA_MIME.has(mime)) {
    // octet-stream is only accepted for known media/font extensions (some browsers send it for .mov/.woff2)
    if (mime !== 'application/octet-stream') return true;
    return ['.mov', '.mkv', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a'].includes(ext);
  }
  return false;
}

function mediaTypeFor(mimetype) {
  const m = String(mimetype || '');
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'other';
}

function createUpload({ dir = UPLOAD_DIR, maxMb = MAX_UPLOAD_MB } = {}) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, `${Date.now()}_${nanoid(8)}${ext}`);
    }
  });

  return multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024, files: 20 },
    fileFilter: (req, file, cb) => {
      if (isAllowed(file)) return cb(null, true);
      const err = new Error(`File type not allowed: ${file.originalname}`);
      err.statusCode = 400;
      cb(err);
    }
  });
}

module.exports = { createUpload, UPLOAD_DIR, mediaTypeFor, isAllowed };
