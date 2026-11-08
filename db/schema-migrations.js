/**
 * Ordered, run-once schema migrations.
 *
 * Every migration is additive: legacy columns/rows are left in place so the
 * previous version of Quandary Control can still open the same database file.
 */
const { nanoid } = require('nanoid');

function safeJson(str, fallback) {
  if (str === null || str === undefined || str === '') return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function columnNames(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  } catch (_) {
    return [];
  }
}

const LEGACY_OPERATOR_MAP = {
  equals: 'equals',
  not_equals: 'not_equals',
  greater_than: 'gt',
  less_than: 'lt',
  contains: 'contains',
  changes_to: 'equals',
  changes_from: 'changes_from'
};

/**
 * Convert one legacy `config.triggers[]` entry to the automation shape.
 */
function convertLegacyTrigger(trigger) {
  const variable = String(trigger.variable || '');
  const value = trigger.value;
  const operator = LEGACY_OPERATOR_MAP[trigger.condition] || 'equals';

  let triggerConfig;
  const timerMatch = variable.match(/^timer_(main|secondary)(_remaining)?$/);
  if (timerMatch && (operator === 'equals') && !isNaN(Number(value))) {
    triggerConfig = {
      type: 'timer',
      timer: timerMatch[1],
      event: timerMatch[2] ? 'remaining' : 'elapsed',
      seconds: Number(value)
    };
  } else {
    triggerConfig = { type: 'variable', variable, operator, value };
  }

  const actions = (Array.isArray(trigger.actions) ? trigger.actions : []).map(convertLegacyAction).filter(Boolean);
  return { name: trigger.name || `When ${variable} ${operator} ${value}`, trigger: triggerConfig, actions };
}

function convertLegacyAction(action) {
  if (!action || !action.type) return null;
  switch (action.type) {
    case 'show_message':
      return { type: 'show_message', text: action.text || '', duration: Number(action.duration) || 5, style: 'info' };
    case 'show_media':
      return { type: 'show_media', mediaId: action.mediaId || '', url: action.file || '', headline: action.headline || '', duration: Number(action.duration) || 0 };
    case 'play_sound':
      return { type: 'play_sound', url: action.file || action.url || '', volume: Number(action.volume) || 70 };
    case 'set_variable':
    case 'update_variable':
      return { type: 'set_variable', variable: action.variable || '', mode: 'set', value: action.value };
    case 'timer_control':
      return { type: 'timer', timer: 'main', command: action.action || 'start', seconds: Number(action.amount) || 0 };
    case 'send_webhook':
      return {
        type: 'http_request',
        method: action.method || 'POST',
        url: action.url || '',
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        body: action.payload ? JSON.stringify(action.payload, null, 2) : ''
      };
    case 'send_hint':
      return { type: 'send_hint', message: action.message || '' };
    default:
      return { type: 'show_message', text: `Unsupported legacy action: ${action.type}`, duration: 3, style: 'warning', disabled: true };
  }
}

function convertLegacySecondaryTimerTrigger(t) {
  const trigger = { type: 'timer', timer: 'secondary', event: 'remaining', seconds: Number(t.timeSeconds) || 0 };
  let action;
  switch (t.action) {
    case 'show_media':
      action = { type: 'show_media', mediaId: t.mediaId || '', headline: t.headline || '', duration: t.autoClose === false ? 0 : (Number(t.autoCloseSeconds) || 5) };
      break;
    case 'update_variable':
      action = { type: 'set_variable', variable: t.variableName || '', mode: 'set', value: t.variableValue };
      break;
    case 'send_hint':
      action = { type: 'send_hint', message: t.message || '' };
      break;
    case 'play_sound':
      action = { type: 'play_sound', url: t.soundId || '', volume: Math.round((Number(t.volume) || 1) * 100) };
      break;
    default:
      return null;
  }
  return { name: `Secondary timer at ${trigger.seconds}s`, trigger, actions: [action] };
}

const MIGRATIONS = [
  {
    id: '2025_legacy_gm_customization_columns',
    up(db) {
      const cols = columnNames(db, 'gm_customizations');
      if (cols.length === 0) return;
      if (!cols.includes('secondary_color')) {
        db.exec("ALTER TABLE gm_customizations ADD COLUMN secondary_color TEXT DEFAULT '#6c757d'");
      }
      if (!cols.includes('title_color')) {
        db.exec("ALTER TABLE gm_customizations ADD COLUMN title_color TEXT DEFAULT '#ffffff'");
      }
    }
  },
  {
    id: '2026_11_core_v2_tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS slideshows (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          settings JSON DEFAULT '{}',
          order_index INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_slideshows_room ON slideshows(room_id, order_index);

        CREATE TABLE IF NOT EXISTS slides (
          id TEXT PRIMARY KEY,
          slideshow_id TEXT NOT NULL,
          type TEXT CHECK(type IN ('image','video','text')) NOT NULL,
          media_url TEXT DEFAULT '',
          title TEXT DEFAULT '',
          body TEXT DEFAULT '',
          settings JSON DEFAULT '{}',
          order_index INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (slideshow_id) REFERENCES slideshows(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_slides_show ON slides(slideshow_id, order_index);

        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          trigger_config JSON NOT NULL,
          conditions JSON DEFAULT '{"mode":"all","rules":[]}',
          actions JSON DEFAULT '[]',
          cooldown_seconds INTEGER DEFAULT 0,
          order_index INTEGER DEFAULT 0,
          hook_key TEXT UNIQUE,
          last_run_at DATETIME,
          run_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_automations_room ON automations(room_id, order_index);
      `);
    }
  },
  {
    id: '2026_11_import_legacy_rules_as_slideshows',
    up(db) {
      const rooms = db.prepare('SELECT id FROM rooms').all();
      const mediaStmt = db.prepare('SELECT * FROM room_media WHERE room_id = ? ORDER BY order_index ASC, created_at ASC');
      const insertShow = db.prepare(`INSERT INTO slideshows (id, room_id, name, description, settings, order_index) VALUES (?, ?, ?, ?, ?, 0)`);
      const insertSlide = db.prepare(`INSERT INTO slides (id, slideshow_id, type, media_url, title, body, settings, order_index) VALUES (?, ?, ?, ?, ?, '', ?, ?)`);
      const hasShows = db.prepare('SELECT COUNT(*) AS n FROM slideshows WHERE room_id = ?');

      for (const room of rooms) {
        if (hasShows.get(room.id).n > 0) continue;
        const rules = mediaStmt.all(room.id).filter(m => safeJson(m.metadata, {}).category === 'rules');
        const usable = rules.filter(r => r.type === 'image' || r.type === 'video');
        if (usable.length === 0) continue;

        const showId = nanoid(12);
        insertShow.run(showId, room.id, 'Rules', 'Imported from the original rules editor', JSON.stringify({ advance: 'manual', transition: 'fade' }));
        usable.forEach((r, idx) => {
          // Legacy titles were just upload filenames and were never shown, so don't import them as captions
          insertSlide.run(nanoid(12), showId, r.type, r.url, '', JSON.stringify({ fit: 'contain', duration: 0 }), idx);
        });
      }
    }
  },
  {
    id: '2026_11_import_legacy_triggers_as_automations',
    up(db) {
      const rooms = db.prepare('SELECT id, config FROM rooms').all();
      const existing = db.prepare('SELECT COUNT(*) AS n FROM automations WHERE room_id = ?');
      const insert = db.prepare(`
        INSERT INTO automations (id, room_id, name, enabled, trigger_config, conditions, actions, order_index)
        VALUES (?, ?, ?, 1, ?, '{"mode":"all","rules":[]}', ?, ?)
      `);

      for (const room of rooms) {
        if (existing.get(room.id).n > 0) continue;
        const config = safeJson(room.config, {});
        const converted = [];
        (Array.isArray(config.triggers) ? config.triggers : []).forEach(t => converted.push(convertLegacyTrigger(t)));
        (Array.isArray(config.secondaryTimerTriggers) ? config.secondaryTimerTriggers : []).forEach(t => {
          const c = convertLegacySecondaryTimerTrigger(t);
          if (c) converted.push(c);
        });
        converted.forEach((c, idx) => {
          insert.run(nanoid(12), room.id, c.name, JSON.stringify(c.trigger), JSON.stringify(c.actions), idx);
        });
      }
    }
  },
  {
    id: '2026_11_strip_persisted_timer_variables',
    up(db) {
      // Timer variables are now served live from memory; the old code rewrote them
      // into api_variables every second as {type,value,system} objects.
      const rooms = db.prepare('SELECT id, api_variables FROM rooms').all();
      const update = db.prepare('UPDATE rooms SET api_variables = ? WHERE id = ?');
      for (const room of rooms) {
        const vars = safeJson(room.api_variables, {});
        if (!vars || typeof vars !== 'object' || Array.isArray(vars)) continue;
        let changed = false;
        for (const key of Object.keys(vars)) {
          const v = vars[key];
          if (/^timer_(main|secondary)(_remaining)?$/.test(key) && v && typeof v === 'object' && v.system) {
            delete vars[key];
            changed = true;
          }
        }
        if (changed) update.run(JSON.stringify(vars), room.id);
      }
    }
  }
];

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  const mark = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const run = db.transaction(() => {
      migration.up(db);
      mark.run(migration.id);
    });
    run();
  }
}

module.exports = {
  runMigrations,
  convertLegacyTrigger,
  convertLegacyAction,
  safeJson,
  MIGRATIONS
};
