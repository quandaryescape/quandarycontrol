const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('GM and slideshow page controls', () => {
  let window, document;
  function load(page) {
    const dom = new JSDOM(read(page), { runScripts: 'outside-only', url: 'http://localhost/room/test/slideshows' });
    window = dom.window; document = window.document;
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.eval(read('js/ui.js'));
    window.QC.setRoomFavicon = () => {};
    return window.QC;
  }
  afterEach(() => window.close());
  test('select another slideshow, edit its properties, delete a thumbnail and save', async () => {
    const QC = load('slideshow-editor.html');
    window.eval(read('js/slideshow-render.js'));
    const shows = ['a', 'b'].map(id => ({ id, name: id, settings: { advance: 'manual' }, slides: [1, 2].map(n => ({ type: 'text', title: `${id}${n}`, settings: {} })), slideCount: 2 }));
    QC.get = jest.fn(async url => {
      if (url === '/api/v2/rooms/test') return { name: 'Room' };
      if (url.endsWith('/slideshows')) return shows;
      return JSON.parse(JSON.stringify(shows.find(s => url.endsWith('/' + s.id))));
    });
    QC.put = jest.fn(async (url, data) => ({ ...data, id: url.split('/').pop() }));
    window.eval(read('js/slideshow-editor.js'));
    await flush();
    document.querySelectorAll('.show-item')[1].click();
    await flush();
    expect(document.querySelector('#show-name').value).toBe('b');
    expect(document.querySelector('#in-title').value).toBe('b1');
    document.querySelector('#in-title').value = 'Edited B';
    document.querySelector('#in-title').dispatchEvent(new window.Event('input'));
    document.querySelectorAll('.film [data-del]')[1].click();
    expect(document.querySelectorAll('.film')).toHaveLength(1);
    document.querySelectorAll('.show-item')[0].click();
    await flush();
    expect(QC.put).toHaveBeenCalledWith('/api/v2/slideshows/b', expect.objectContaining({ slides: [expect.objectContaining({ title: 'Edited B' })] }));
    expect(document.querySelector('#in-title').value).toBe('a1');
  });
  test('GM speed shortcuts, custom value and state indicator', async () => {
    const QC = load('gm.html');
    const handlers = {}, socket = { on: (event, fn) => { handlers[event] = fn; }, emit: jest.fn() };
    window.io = () => socket;
    QC.get = jest.fn(async url => url === '/api/v2/rooms/test' ? { id: 'test', name: 'Room', timer: {}, hints: {} } : []);
    QC.prompt = jest.fn(async () => '0.6');
    window.eval(read('js/gm-app.js'));
    await flush();
    document.querySelector('[data-speed="0.75"]').click();
    expect(socket.emit).toHaveBeenCalledWith('timer_control', { roomId: 'test', action: 'speed', amount: 0.75 });
    document.querySelector('#timer-speed').click();
    await flush();
    expect(socket.emit).toHaveBeenCalledWith('timer_control', { roomId: 'test', action: 'speed', amount: 0.6 });
    handlers.timer_update({ remaining: 600, duration: 900, running: true, speed: 0.6 });
    expect(document.querySelector('#timer-speed').textContent).toContain('Slower');
    expect(document.querySelector('#main-timer-card').classList.contains('speed-modified')).toBe(true);
    handlers.timer_update({ remaining: 600, duration: 900, running: true, speed: 1.5 });
    expect(document.querySelector('#timer-speed').textContent).toContain('Faster');
    handlers.timer_update({ remaining: 600, duration: 900, running: true, speed: 1 });
    expect(document.querySelector('#main-timer-card').classList.contains('speed-modified')).toBe(false);
  });
});
