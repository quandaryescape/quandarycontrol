/**
 * Game history: games are created from timer activity once they've run long
 * enough, closed on time-up / reset, and listed + edited through /api/v2/games.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.QUANDARY_DB_PATH = ':memory:';
const tmpThemes = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-themes-'));
fs.cpSync(path.join(__dirname, '..', '..', 'themes', 'boilerplate'), path.join(tmpThemes, 'boilerplate'), { recursive: true });
process.env.QUANDARY_THEMES_DIR = tmpThemes;

const request = require('supertest');
const { createServer } = require('../../src/app');
const { getDatabase } = require('../../db/database');

let instance, app, ts, io, clock;
const MIN = 60;

beforeAll(() => {
  instance = createServer();
  ({ app, timerService: ts, io } = instance);
});

afterAll(() => {
  instance.shutdown();
  io.close();
  fs.rmSync(tmpThemes, { recursive: true, force: true });
});

// Drive the timer with a fake clock instead of waiting
beforeEach(() => {
  clock = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

function advance(roomId, seconds) {
  clock += seconds * 1000;
  ts.tick(roomId, 'main');
}

async function createRoom(duration = 60 * MIN) {
  const res = await request(app).post('/api/v2/rooms').send({ name: 'Board to Death', timer: { duration } });
  const room = res.body.data;
  ts.initializeTimer(room.id, duration, 'main');
  return room;
}

async function games(roomId) {
  const res = await request(app).get('/api/v2/games').query(roomId ? { room: roomId } : {});
  expect(res.status).toBe(200);
  return res.body.data;
}

test('a start that is reset before 10 minutes is not saved', async () => {
  const room = await createRoom();
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 9 * MIN);
  ts.resetTimer(room.id, null, 'main', io);
  expect((await games(room.id)).total).toBe(0);
});

test('saved after 10 minutes, counts hints and chat, ends when paused then reset', async () => {
  const room = await createRoom();
  const startedAt = clock;
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 5 * MIN);
  await request(app).post(`/api/v2/rooms/${room.id}/hint`).send({ message: 'Check the clock' }); // before it counts
  advance(room.id, 5 * MIN);

  let list = await games(room.id);
  expect(list.total).toBe(1);
  expect(list.items[0]).toMatchObject({ status: 'in_progress', roomName: 'Board to Death', hints: 1, elapsed: 600 });
  expect(Date.parse(list.items[0].startedAt)).toBe(startedAt);

  instance.automationEngine.onRoomEvent(room.id, 'player_message', {});
  instance.automationEngine.onRoomEvent(room.id, 'gm_message', {});
  advance(room.id, 32 * MIN);
  ts.pauseTimer(room.id, 'main', io); // they escaped with 18:00 left
  const pausedAt = clock;
  clock += 20 * MIN * 1000;           // celebrating, photos…
  ts.resetTimer(room.id, null, 'main', io);

  list = await games(room.id);
  expect(list.items[0]).toMatchObject({
    status: 'ended', endReason: 'reset', elapsed: 42 * MIN, remaining: 18 * MIN, duration: 60 * MIN,
    hints: 1, playerMessages: 1, gmMessages: 1, result: null
  });
  expect(Date.parse(list.items[0].endedAt)).toBe(pausedAt);
});

test('time running out ends the game; starting again begins a new one', async () => {
  const room = await createRoom(30 * MIN);
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 30 * MIN);
  let list = await games(room.id);
  expect(list.items[0]).toMatchObject({ status: 'ended', endReason: 'time_up', remaining: 0, elapsed: 30 * MIN });

  ts.startTimer(room.id, 'main', io); // restarted straight after time's up
  advance(room.id, 11 * MIN);
  list = await games(room.id);
  expect(list.total).toBe(2);
  expect(list.items[0].status).toBe('in_progress');
  ts.stopTimer(room.id, 'main', io);
  expect((await games(room.id)).items[0].endReason).toBe('stopped');
});

test('a timer shorter than the threshold counts once it runs out', async () => {
  const room = await createRoom(5 * MIN);
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 4 * MIN);
  expect((await games(room.id)).total).toBe(0);
  advance(room.id, 1 * MIN);
  expect((await games(room.id)).items[0]).toMatchObject({ endReason: 'time_up', elapsed: 5 * MIN });
});

test('threshold is a setting (1–60 minutes)', async () => {
  expect((await request(app).get('/api/v2/settings')).body.data.gameLog).toEqual({ minMinutes: 10 });
  expect((await request(app).put('/api/v2/settings').send({ gameLog: { minMinutes: 0 } })).status).toBe(400);
  expect((await request(app).put('/api/v2/settings').send({ gameLog: { minMinutes: 61 } })).status).toBe(400);
  const res = await request(app).put('/api/v2/settings').send({ gameLog: { minMinutes: 20 } });
  expect(res.body.data.gameLog.minMinutes).toBe(20);

  const room = await createRoom();
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 15 * MIN);
  expect((await games(room.id)).total).toBe(0);
  advance(room.id, 5 * MIN);
  expect((await games(room.id)).total).toBe(1);
  ts.resetTimer(room.id, null, 'main', io);
  await request(app).put('/api/v2/settings').send({ gameLog: { minMinutes: 10 } });
});

test('GMs can add team, result and notes, and delete a game', async () => {
  const room = await createRoom();
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 12 * MIN);
  ts.resetTimer(room.id, null, 'main', io);
  const [game] = (await games(room.id)).items;

  expect((await request(app).put(`/api/v2/games/${game.id}`).send({ result: 'won' })).status).toBe(400);
  const res = await request(app).put(`/api/v2/games/${game.id}`).send({ result: 'escaped', teamName: '  The Smiths ', notes: 'Birthday' });
  expect(res.body.data).toMatchObject({ result: 'escaped', teamName: 'The Smiths', notes: 'Birthday' });
  expect((await request(app).put(`/api/v2/games/${game.id}`).send({ result: null })).body.data.result).toBeNull();

  expect((await request(app).delete(`/api/v2/games/${game.id}`)).status).toBe(200);
  expect((await games(room.id)).total).toBe(0);
  expect((await request(app).delete(`/api/v2/games/${game.id}`)).status).toBe(404);
});

test('deleting a room keeps its history; open games are closed on restart', async () => {
  const room = await createRoom();
  ts.startTimer(room.id, 'main', io);
  advance(room.id, 15 * MIN);
  await request(app).delete(`/api/v2/rooms/${room.id}`);
  const [game] = (await games(room.id)).items;
  expect(game).toMatchObject({ status: 'ended', endReason: 'interrupted', roomName: 'Board to Death', roomExists: false });

  // A game the previous run never closed (server restarted mid-game)
  getDatabase().prepare(`INSERT INTO games (id, room_id, room_name, status, started_at, updated_at)
    VALUES ('stale', 'gone', 'Old room', 'in_progress', '2026-01-01T10:00:00.000Z', '2026-01-01T10:40:00.000Z')`).run();
  expect(instance.gameLog.closeInterrupted()).toBe(1);
  const stale = instance.gameLog.get('stale');
  expect(stale).toMatchObject({ status: 'ended', endReason: 'interrupted', endedAt: '2026-01-01T10:40:00.000Z' });
});

test('list spans all rooms, newest first, with paging', async () => {
  const all = await games();
  expect(all.total).toBeGreaterThan(3);
  const times = all.items.map(g => Date.parse(g.startedAt));
  expect([...times].sort((a, b) => b - a)).toEqual(times);
  const page = (await request(app).get('/api/v2/games').query({ limit: 2, offset: 1 })).body.data;
  expect(page.items.map(g => g.id)).toEqual(all.items.slice(1, 3).map(g => g.id));
});
