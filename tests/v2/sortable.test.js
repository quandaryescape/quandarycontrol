const fs = require('fs');
const { JSDOM } = require('jsdom');

describe('sortable click and drag interactions', () => {
  let dom, window, document, list, onEnd;
  beforeEach(() => {
    dom = new JSDOM('<div id="list"><button class="item" data-id="a"><span>Show A</span><span role="button">Options</span></button><div class="item" data-id="b"><button>Delete</button></div></div>', { runScripts: 'outside-only', url: 'http://localhost' });
    ({ window } = dom); ({ document } = window);
    window.eval(fs.readFileSync(require.resolve('../../public/js/ui.js'), 'utf8'));
    list = document.querySelector('#list');
    [...list.children].forEach((el, i) => { el.getBoundingClientRect = () => ({ top: i * 100, left: 0, width: 100, height: 100 }); });
    onEnd = jest.fn();
    window.QC.sortable(list, { items: '.item', onEnd });
  });
  afterEach(() => window.close());
  function pointer(target, type, y = 20) {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
    return event;
  }
  test('ordinary slideshow click leaves the item in place and clickable', () => {
    const item = list.firstElementChild;
    const clicked = jest.fn(); item.onclick = clicked;
    expect(pointer(item.firstElementChild, 'pointerdown').defaultPrevented).toBe(false);
    expect(item.style.pointerEvents).toBe('');
    expect(list.children).toHaveLength(2);
    pointer(item.firstElementChild, 'pointerup');
    item.firstElementChild.click();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });
  test('thumbnail delete and nested menu buttons never start dragging', () => {
    for (const button of [list.querySelector('[role="button"]'), list.lastElementChild.firstElementChild]) {
      const clicked = jest.fn(); button.onclick = clicked;
      pointer(button, 'pointerdown');
      pointer(document, 'pointermove', 190);
      expect(list.children).toHaveLength(2);
      pointer(button, 'pointerup', 190); button.click();
      expect(clicked).toHaveBeenCalledTimes(1);
    }
    expect(onEnd).not.toHaveBeenCalled();
  });
  test('actual drag reorders, preserves styling, and suppresses its click', () => {
    const item = list.firstElementChild;
    item.style.color = 'red';
    const clicked = jest.fn(); list.onclick = clicked;
    pointer(item, 'pointerdown');
    pointer(document, 'pointermove', 190);
    expect(list.querySelector('.sortable-placeholder')).not.toBeNull();
    pointer(document, 'pointerup', 190);
    expect([...list.children].map(x => x.dataset.id)).toEqual(['b', 'a']);
    expect(onEnd).toHaveBeenCalledWith(['b', 'a'], item);
    expect(item.style.color).toBe('red');
    item.click(); expect(clicked).not.toHaveBeenCalled();
  });
  test('cancelled drag restores the original order', () => {
    pointer(list.firstElementChild, 'pointerdown');
    pointer(document, 'pointermove', 190);
    pointer(document, 'pointercancel', 190);
    expect([...list.children].map(x => x.dataset.id)).toEqual(['a', 'b']);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
