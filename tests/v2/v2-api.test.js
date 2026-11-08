/**
 * Integration tests for the v2 backend: rooms, variables, automations,
 * webhooks, slideshows, themes, legacy compatibility and optional auth.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate from the real database and themes before anything loads them
process.env.QUANDARY_DB_PATH = ':memory:';
const tmpThemes = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-themes-'));
fs.cpSync(path.join(__dirname, '..', '..', 'themes', 'boilerplate'), path.join(tmpThemes, 'boilerplate'), { recursive: true });
process.env.QUANDARY_THEMES_DIR = tmpThemes;

const request = require('supertest');
const { createServer } = require('../../src/app');
const { getDatabase } = require('../../db/database');

let instance;
let app;

beforeAll(() => {
  instance = createServer();
  app = instance.app;
});

afterAll(() => {
  instance.shutdown();
  instance.io.close();
  fs.rmSync(tmpThemes, { recursive: true, force: true });
});

const flush = () => new Promise(r => setTimeout(r, 30));

async function createRoom(body = {}) {
  const res = await request(app).post('/api/v2/rooms').send({ name: 'Test Room', ...body });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('rooms', () => {
  test('create, update structured settings, read back', async () => {
    const room = await createRoom({ timer: { duration: 2700 } });
    expect(room.shortcode).toMatch(/^[A-Z2-9]{4,}$/);
    expect(room.timer.duration).toBe(2700);

    const res = await request(app).put(`/api/v2/rooms/${room.id}`).send({
      name: 'Renamed',
      gmNotes: 'Lock code is 1234',
      timer: { secondaryEnabled: true, secondaryDuration: 600 },
      hints: { type: 'chat', presets: [{ text: 'Look under the rug', category: 'Room 1' }, { text: '  ' }] }
    });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
    expect(res.body.data.gmNotes).toBe('Lock code is 1234');
    expect(res.body.data.timer.secondaryEnabled).toBe(true);
    expect(res.body.data.hints.type).toBe('chat');
    expect(res.body.data.hints.presets).toHaveLength(1);

    const pub = await request(app).get(`/api/v2/rooms/${room.shortcode}/public`);
    expect(pub.body.data.gmNotes).toBeUndefined();
    expect(pub.body.data.name).toBe('Renamed');
  });

  test('rejects unknown themes', async () => {
    const room = await createRoom();
    const res = await request(app).put(`/api/v2/rooms/${room.id}`).send({ theme: '../../etc' });
    expect(res.status).toBe(400);
  });

  test('duplicate copies slideshows and automations', async () => {
    const room = await createRoom();
    await request(app).post(`/api/v2/rooms/${room.id}/slideshows`).send({ name: 'Intro' });
    await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({ name: 'Hook', trigger: { type: 'webhook' }, actions: [] });
    const dup = await request(app).post(`/api/v2/rooms/${room.id}/duplicate`).send({});
    expect(dup.status).toBe(201);
    expect(dup.body.data.stats).toEqual({ slideshows: 1, automations: 1 });
    expect(dup.body.data.shortcode).not.toBe(room.shortcode);
  });
});

describe('variables', () => {
  test('legacy endpoint stores "false" as boolean false (was true before)', async () => {
    const room = await createRoom();
    await request(app).post(`/api/rooms/${room.id}/variables/door`).send({ value: 'false', type: 'boolean' }).expect(201);
    const res = await request(app).get(`/api/v2/rooms/${room.id}/variables`);
    expect(res.body.data.user.door).toBe(false);
  });

  test('hardware GET endpoints work with the short code', async () => {
    const room = await createRoom();
    await request(app).get(`/api/v2/rooms/${room.shortcode}/variables/score/set?value=5`).expect(200);
    const inc = await request(app).get(`/api/v2/rooms/${room.shortcode}/variables/score/increment?by=3`);
    expect(inc.body.data.value).toBe(8);
    const tog = await request(app).post(`/api/v2/rooms/${room.shortcode}/variables/lights/toggle`);
    expect(tog.body.data.value).toBe(true);
  });

  test('timer variables are read-only and served live', async () => {
    const room = await createRoom();
    const bad = await request(app).put(`/api/v2/rooms/${room.id}/variables/timer_main`).send({ value: 3 });
    expect(bad.status).toBe(400);
    await request(app).post(`/api/v2/rooms/${room.id}/timer/reset`);
    const res = await request(app).get(`/api/v2/rooms/${room.id}/variables`);
    expect(res.body.data.timers.timer_main_remaining).toBe(3600);
  });
});

describe('automations', () => {
  test('variable trigger is edge-triggered and conditions are respected', async () => {
    const room = await createRoom();
    const io = instance.io;
    const emitted = [];
    const origTo = io.to.bind(io);
    io.to = (r) => ({ emit: (ev, data) => { if (r === room.id) emitted.push([ev, data]); return origTo(r).emit(ev, data); } });

    await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({
      name: 'Door opens',
      trigger: { type: 'variable', variable: 'door', operator: 'equals', value: 'open' },
      conditions: { mode: 'all', rules: [{ variable: 'power', operator: 'is_true' }] },
      actions: [{ type: 'send_hint', message: 'Door is {{door}} in {{room.name}}' }]
    }).expect(201);

    const set = (name, value) => instance.variableService.setVariable(room.id, name, value, { source: 'test' });

    set('power', false);
    set('door', 'open');
    await flush();
    expect(emitted.filter(e => e[0] === 'hintReceived')).toHaveLength(0); // condition false

    set('door', 'closed');
    set('power', true);
    set('door', 'open');
    await flush();
    set('door', 'open'); // unchanged: no re-fire
    await flush();
    const hints = emitted.filter(e => e[0] === 'hintReceived');
    expect(hints).toHaveLength(1);
    expect(hints[0][1].message).toBe('Door is open in Test Room');
    io.to = origTo;
  });

  test('chained set_variable is loop-protected', async () => {
    const room = await createRoom();
    await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({
      name: 'ping',
      trigger: { type: 'variable', variable: 'a', operator: 'any_change' },
      actions: [{ type: 'set_variable', variable: 'a', mode: 'increment', value: 1 }]
    });
    instance.variableService.setVariable(room.id, 'a', 0);
    await new Promise(r => setTimeout(r, 150));
    const value = instance.variableService.getUserVariables(room.id).a;
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(15);
    const logs = instance.automationEngine.getLogs(room.id);
    expect(logs.some(l => /loop/i.test(l.message))).toBe(true);
  });

  test('webhook URL runs the automation with payload templating', async () => {
    const room = await createRoom();
    const created = await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({
      name: 'Prop solved',
      trigger: { type: 'webhook' },
      actions: [{ type: 'set_variable', variable: 'solved_by', mode: 'set', value: '{{payload.who}}' }]
    });
    const hook = created.body.data.webhookUrl;
    expect(hook).toMatch(/\/api\/hooks\/[\w-]{16}$/);
    const key = hook.split('/').pop();
    const res = await request(app).get(`/api/hooks/${key}?who=keypad`);
    expect(res.body.ran).toBe(true);
    expect(instance.variableService.getUserVariables(room.id).solved_by).toBe('keypad');
    await request(app).get('/api/hooks/doesnotexist').expect(404);
  });

  test('timer trigger fires when remaining time crosses the threshold', async () => {
    const room = await createRoom();
    const created = instance.automationEngine.create(room.id, {
      name: '5 minutes left',
      trigger: { type: 'timer', timer: 'main', event: 'remaining', seconds: 300 },
      actions: [{ type: 'set_variable', variable: 'warned', mode: 'set', value: 'yes' }]
    });
    expect(created.id).toBeTruthy();
    await instance.automationEngine.onTimerTick(room.id, 'main', { remaining: 302, previous: 303, duration: 3600 });
    expect(instance.variableService.getUserVariables(room.id).warned).toBeUndefined();
    await instance.automationEngine.onTimerTick(room.id, 'main', { remaining: 299, previous: 301, duration: 3600 }); // skipped 300
    expect(instance.variableService.getUserVariables(room.id).warned).toBe('yes');
  });

  test('test endpoint runs actions regardless of conditions', async () => {
    const room = await createRoom();
    const a = await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({
      name: 'Manual', trigger: { type: 'manual', label: 'Blackout' },
      conditions: { mode: 'all', rules: [{ variable: 'never', operator: 'is_true' }] },
      actions: [{ type: 'set_variable', variable: 'lights', mode: 'set', value: 'off' }]
    });
    const res = await request(app).post(`/api/v2/automations/${a.body.data.id}/test`);
    expect(res.body.data.ran).toBe(true);
    expect(instance.variableService.getUserVariables(room.id).lights).toBe('off');
  });

  test('timer action controls the real server timer', async () => {
    const room = await createRoom({ timer: { duration: 600 } });
    const a = await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({
      name: 'Bonus', trigger: { type: 'manual' },
      actions: [{ type: 'timer', timer: 'main', command: 'add', seconds: 120 }]
    });
    await request(app).post(`/api/v2/automations/${a.body.data.id}/test`);
    expect(instance.timerService.getTimerState(room.id, 'main').remaining).toBe(720);
  });
});

describe('slideshows', () => {
  test('multiple slideshows per room with full slide save', async () => {
    const room = await createRoom();
    const a = await request(app).post(`/api/v2/rooms/${room.id}/slideshows`).send({ name: 'Kids rules' });
    await request(app).post(`/api/v2/rooms/${room.id}/slideshows`).send({ name: 'Adult rules' });

    const put = await request(app).put(`/api/v2/slideshows/${a.body.data.id}`).send({
      settings: { advance: 'auto', autoSeconds: 5, transition: 'bogus' },
      slides: [
        { type: 'text', title: 'Welcome', body: 'Have fun' },
        { type: 'image', media_url: '/uploads/x.png', settings: { fit: 'cover' } },
        { type: 'nonsense', title: 'coerced to text' }
      ]
    });
    expect(put.status).toBe(200);
    expect(put.body.data.slides.map(s => s.type)).toEqual(['text', 'image', 'text']);
    expect(put.body.data.settings.transition).toBe('fade');
    expect(put.body.data.estimatedSeconds).toBe(15);

    const list = await request(app).get(`/api/v2/rooms/${room.id}/slideshows`);
    expect(list.body.data.map(s => s.name)).toEqual(['Kids rules', 'Adult rules']);

    const reordered = await request(app).post(`/api/v2/rooms/${room.id}/slideshows/reorder`).send({ ids: list.body.data.map(s => s.id).reverse() });
    expect(reordered.body.data[0].name).toBe('Adult rules');
  });

  test('legacy rules media is imported into a slideshow by the migration', () => {
    const { MIGRATIONS } = require('../../db/schema-migrations');
    const db = getDatabase();
    db.prepare("INSERT INTO rooms (id, shortcode, name, config) VALUES ('legacyroom', 'LEGC', 'Legacy', '{\"triggers\":[{\"name\":\"t\",\"variable\":\"timer_main_remaining\",\"condition\":\"equals\",\"value\":\"60\",\"actions\":[{\"type\":\"show_message\",\"text\":\"1 min\"}]}]}')").run();
    db.prepare("INSERT INTO room_media (id, room_id, type, url, metadata, order_index) VALUES ('m1','legacyroom','image','/uploads/a.png','{\"category\":\"rules\"}',0)").run();
    MIGRATIONS.find(m => m.id.includes('rules_as_slideshows')).up(db);
    MIGRATIONS.find(m => m.id.includes('triggers_as_automations')).up(db);
    const show = db.prepare("SELECT * FROM slideshows WHERE room_id = 'legacyroom'").get();
    expect(show.name).toBe('Rules');
    const auto = db.prepare("SELECT * FROM automations WHERE room_id = 'legacyroom'").get();
    expect(JSON.parse(auto.trigger_config)).toEqual({ type: 'timer', timer: 'main', event: 'remaining', seconds: 60 });
  });
});

describe('themes', () => {
  test('create from starter, edit, preview draft, delete', async () => {
    const created = await request(app).post('/api/v2/themes').send({ name: 'Haunted Lab' });
    expect(created.status).toBe(201);
    const slug = created.body.data.slug;
    expect(slug).toBe('haunted-lab');
    expect(created.body.data.html).toContain('[timer');

    const saved = await request(app).put(`/api/v2/themes/${slug}`).send({ css: 'body{background:#000}' });
    expect(saved.body.data.css).toBe('body{background:#000}');

    const room = await createRoom({ theme: slug });
    const preview = await request(app).post('/api/v2/themes/preview').send({ slug, html: created.body.data.html, css: '.qt-title{color:lime}' });
    const page = await request(app).get(`/room/${room.id}/player?themePreview=${preview.body.data.token}&editor=1`);
    expect(page.text).toContain('.qt-title{color:lime}');
    expect(page.text).toContain('theme-preview-bridge.js');
    expect(page.text).toContain('timer-display');

    const blocked = await request(app).delete(`/api/v2/themes/${slug}`);
    expect(blocked.status).toBe(409); // still used by a room
    await request(app).put(`/api/v2/rooms/${room.id}`).send({ theme: 'boilerplate' });
    await request(app).delete(`/api/v2/themes/${slug}`).expect(200);
  });

  test('boilerplate is protected and slugs are validated', async () => {
    await request(app).put('/api/v2/themes/boilerplate').send({ css: '' }).expect(403);
    await request(app).get('/api/v2/themes/..%2F..%2Fdb').expect(400);
  });

  test('player route falls back safely for a tampered theme name', async () => {
    const room = await createRoom();
    getDatabase().prepare('UPDATE rooms SET config = ? WHERE id = ?').run(JSON.stringify({ theme: '../../db' }), room.id);
    const page = await request(app).get(`/room/${room.id}/player`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('timer-display');
  });
});

describe('settings & AI', () => {
  test('API key is stored but never returned in full', async () => {
    const key = 'sk-or-v1-' + 'a'.repeat(40);
    const res = await request(app).put('/api/v2/settings').send({ ai: { apiKey: key, model: 'anthropic/claude-sonnet-4.5' } });
    expect(res.body.data.ai.configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(key);
    expect(res.body.data.ai.keyPreview).toMatch(/^sk-or-…aaaa$/);
    await request(app).put('/api/v2/settings').send({ ai: { apiKey: '' } });
  });

  test('AI response parser extracts summary and files', () => {
    const { parseResponse, pickDefaultModel } = require('../../src/services/ai-service');
    const out = parseResponse('<summary>Made it red.</summary>\n<file name="style.css">\n```css\nbody{color:red}\n```\n</file>');
    expect(out.summary).toBe('Made it red.');
    expect(out.files.css.trim()).toBe('body{color:red}');
    expect(pickDefaultModel([{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-3.5-sonnet' }, { id: 'anthropic/claude-sonnet-4.5' }])).toBe('anthropic/claude-sonnet-4.5');
  });
});

describe('optional admin password', () => {
  afterEach(() => { delete process.env.ADMIN_PASSWORD; });

  test('protects admin tools but not players, hooks or hardware endpoints', async () => {
    const room = await createRoom();
    process.env.ADMIN_PASSWORD = 'letmein';
    await request(app).get('/').expect(401);
    await request(app).get('/api/v2/rooms').expect(401);
    await request(app).get('/api/v2/rooms').auth('admin', 'letmein').expect(200);
    await request(app).get(`/room/${room.id}/player`).expect(200);
    await request(app).get(`/api/v2/rooms/${room.shortcode}/variables/x/set?value=1`).expect(200);
    await request(app).get(`/api/v2/rooms/${room.id}/slideshows`).expect(200);
  });
});

describe('legacy API compatibility (used by existing themes & hardware)', () => {
  test('room, shortcode, variables, hints and rules endpoints still respond', async () => {
    const room = await createRoom();
    const list = await request(app).get('/api/rooms').expect(200);
    expect(list.body.data.some(r => r.id === room.id)).toBe(true);
    await request(app).get(`/api/rooms/${room.id}`).expect(200);
    const byCode = await request(app).get(`/api/shortcode/${room.shortcode}`).expect(200);
    expect(byCode.body.data.id).toBe(room.id);

    await request(app).post(`/api/rooms/${room.id}/variables`).send({ name: 'lever', type: 'integer', value: '4' }).expect(201);
    const vars = await request(app).get(`/api/rooms/${room.id}/variables`).expect(200);
    const lever = vars.body.data.find(v => v.name === 'lever');
    expect(lever.parsed_value).toBe(4);

    await request(app).get(`/api/rooms/${room.id}/hints`).expect(200);
    await request(app).get(`/api/rooms/${room.id}/rules`).expect(200);
    await request(app).get('/p/NOPE').expect(404);
    const redirect = await request(app).get(`/p/${room.shortcode}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(`/room/${room.id}/player`);
  });

  test('old rules editor URL redirects to the slideshow studio', async () => {
    const room = await createRoom();
    const res = await request(app).get(`/room/${room.id}/rules-editor`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/room/${room.id}/slideshows`);
  });
});

describe('realtime (socket.io)', () => {
  const { io: Client } = require('socket.io-client');
  let port;
  let clients = [];

  beforeAll(async () => {
    await new Promise(resolve => instance.server.listen(0, resolve));
    port = instance.server.address().port;
  });
  afterEach(() => { clients.forEach(c => c.close()); clients = []; });
  afterAll(() => new Promise(resolve => instance.server.close(resolve)));

  function connect() {
    const c = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    clients.push(c);
    return new Promise((resolve, reject) => { c.on('connect', () => resolve(c)); c.on('connect_error', reject); });
  }
  const once = (c, ev) => new Promise(resolve => c.once(ev, resolve));

  test('GM hint reaches players; presence ignores preview clients', async () => {
    const room = await createRoom();
    const gm = await connect();
    const player = await connect();
    const preview = await connect();

    const presence = [];
    gm.on('presence', p => presence.push(p));
    gm.emit('join_room', { roomId: room.id, clientType: 'gm' });
    await once(gm, 'timer_update');
    player.emit('join_room', { roomId: room.id, clientType: 'player' });
    await once(player, 'timer_update');
    preview.emit('join_room', { roomId: room.id, clientType: 'preview' });
    await once(preview, 'timer_update');
    await flush();
    expect(presence[presence.length - 1]).toEqual({ players: 1, gms: 1 });

    const got = once(player, 'hintReceived');
    gm.emit('sendHint', { roomId: room.id, message: '<img src=x onerror=alert(1)> look up' });
    const hint = await got;
    expect(hint.message).toContain('look up');
  });

  test('GM button automation runs over the socket with an ack', async () => {
    const room = await createRoom();
    const auto = await request(app).post(`/api/v2/rooms/${room.id}/automations`).send({
      name: 'Bonus time', trigger: { type: 'manual', label: 'Bonus' },
      actions: [{ type: 'set_variable', variable: 'bonus', mode: 'set', value: 'yes' }]
    });
    const gm = await connect();
    gm.emit('join_room', { roomId: room.id, clientType: 'gm' });
    await once(gm, 'timer_update');
    const ack = await new Promise(resolve => gm.emit('run_automation', { roomId: room.id, automationId: auto.body.data.id }, resolve));
    expect(ack.success).toBe(true);
    expect(instance.variableService.getUserVariables(room.id).bonus).toBe('yes');

    // a player socket may not trigger GM-only controls
    const player = await connect();
    player.emit('join_room', { roomId: room.id, clientType: 'player' });
    await once(player, 'timer_update');
    const denied = await new Promise(resolve => player.emit('run_automation', { roomId: room.id, automationId: auto.body.data.id }, resolve));
    expect(denied.success).toBe(false);
  });

  test('paused timer keeps its progress when time is added', async () => {
    const room = await createRoom({ timer: { duration: 600 } });
    const gm = await connect();
    gm.emit('join_room', { roomId: room.id, clientType: 'gm' });
    await once(gm, 'timer_update');
    const ts = instance.timerService;
    const t = ts.mapFor('main').get(room.id);
    t.remaining = 300; t.status = 'paused'; // simulate a game paused halfway
    gm.emit('timer_control', { roomId: room.id, action: 'adjust', amount: 60 });
    const update = await once(gm, 'timer_update');
    expect(update.remaining).toBe(360); // previously this reset to the full 660
    expect(update.duration).toBe(660);
  });
});
