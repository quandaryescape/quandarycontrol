const TimerService = require('../../src/services/timer-service');
const { setupTimerHandlers } = require('../../src/websocket/handlers/timer-handlers');

describe('variable timer speed', () => {
  let timers;
  beforeEach(() => { jest.useFakeTimers(); timers = new TimerService(); timers.initializeTimer('room', 60); });
  afterEach(() => { timers.clearAllTimers(); jest.useRealTimers(); });
  const advance = ms => jest.advanceTimersByTime(ms);
  test('changes speed without jumping and preserves fractions across pause/resume', () => {
    timers.startTimer('room');
    advance(1250);
    expect(timers.setSpeed('room', 0.5)).toBe(true);
    advance(1500);
    expect(timers.getTimerState('room').remaining).toBe(58);
    timers.pauseTimer('room');
    advance(10000);
    timers.setSpeed('room', 0.75);
    timers.startTimer('room');
    advance(4000);
    expect(timers.getTimerState('room')).toMatchObject({ remaining: 55, speed: 0.75 });
    timers.setSpeed('room', 2);
    advance(5000);
    expect(timers.getTimerState('room').remaining).toBe(45);
  });
  test('adjustments are game seconds and reset/stop restore normal speed', () => {
    timers.setSpeed('room', 0.5);
    timers.startTimer('room');
    advance(10000);
    timers.adjustTimer('room', 10);
    expect(timers.getTimerState('room').remaining).toBe(65);
    timers.adjustTimer('room', -5);
    advance(10000);
    expect(timers.getTimerState('room').remaining).toBe(55);
    timers.resetTimer('room');
    expect(timers.getTimerState('room')).toMatchObject({ remaining: 60, speed: 1, status: 'ready' });
    timers.setSpeed('room', 0.75);
    timers.stopTimer('room');
    expect(timers.getTimerState('room').speed).toBe(1);
  });
  test('slow timer fires crossings and completion once', () => {
    const onTick = jest.fn(), onStateChange = jest.fn();
    timers.setHooks({ onTick, onStateChange });
    timers.setSpeed('room', 0.5);
    timers.startTimer('room');
    advance(120000);
    expect(timers.getTimerState('room')).toMatchObject({ remaining: 0, status: 'complete', running: false });
    expect(onStateChange.mock.calls.filter(c => c[2] === 'complete')).toHaveLength(1);
    expect(onTick.mock.calls.filter(c => c[2].previous > 30 && c[2].remaining <= 30)).toHaveLength(1);
  });
  test.each([0, -1, 2.1, Infinity, NaN, '0.5', null])('rejects invalid speed %s', speed => {
    expect(timers.setSpeed('room', speed)).toBe(false);
    expect(timers.getTimerState('room').speed).toBe(1);
  });
  test('GM socket speed command broadcasts the updated state', () => {
    const handlers = {};
    const socket = { on: (event, fn) => { handlers[event] = fn; }, emit: jest.fn() };
    const io = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    setupTimerHandlers(socket, io, timers);
    handlers.timer_control({ roomId: 'room', action: 'speed', amount: 0.75 });
    expect(io.emit).toHaveBeenCalledWith('timer_update', expect.objectContaining({ speed: 0.75 }));
    expect(socket.emit).not.toHaveBeenCalled();
  });
});
