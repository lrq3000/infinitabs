// Run the actual sidebar helper in a VM; real layout, activation and scrolling are covered by verify_sidebar_autoscroll.py.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/sidebar.js'), 'utf8');
const helper = source.slice(source.indexOf('function scrollElementIntoViewWithContext('), source.indexOf('function escapeHtml('));

class ScrollFixture {
    constructor(top = 220, bottom = 250) {
        this.frames = [];
        this.calls = [];
        this.container = {
            clientTop: 2, clientHeight: 300,
            getBoundingClientRect: () => ({ top: 100, bottom: 404 }),
            getClientRects: () => [this.container.getBoundingClientRect()]
        };
        this.row = this.element('selected', top, bottom);
        const previous = this.element('previous', top - 30, top);
        previous.previousElementSibling = this.element('two-before', top - 60, top - 30);
        this.row.previousElementSibling = previous;
        this.context = vm.createContext({
            tabsContainer: this.container,
            window: { requestAnimationFrame: callback => this.frames.push(callback) }
        });
        vm.runInContext(helper, this.context);
    }

    element(id, top, bottom) {
        return {
            id, isConnected: true, previousElementSibling: null,
            getBoundingClientRect: () => ({ top, bottom }),
            getClientRects() { return [this.getBoundingClientRect()]; },
            scrollIntoView: options => this.calls.push({ id, ...options })
        };
    }

    schedule(options) { this.context.scrollElementIntoViewWithContext(this.row, options); }
    flush() { for (const callback of this.frames.splice(0)) callback(); }
}

test('fully visible selected rows never request scrolling, regardless of preceding context', () => {
    // The selected row fits exactly, but its preceding siblings do not: checking the context target would be wrong.
    for (const [top, bottom] of [[220, 250], [102, 132], [372, 402]]) {
        const fixture = new ScrollFixture(top, bottom);
        fixture.schedule(); fixture.flush();
        assert.deepEqual(fixture.calls, [], `visible row ${top}..${bottom} must stay stationary`);
    }
});

test('clipped and off-screen rows retain automatic contextual reveal', () => {
    for (const [top, bottom] of [[101, 131], [373, 403], [50, 80], [500, 530]]) {
        const fixture = new ScrollFixture(top, bottom);
        fixture.schedule(); fixture.flush();
        assert.deepEqual(fixture.calls, [{ id: 'two-before', behavior: 'smooth', block: 'start' }]);
    }
});

test('visibility is measured after the pending render frame, not when selection is scheduled', () => {
    const fixture = new ScrollFixture(500, 530);
    fixture.schedule();
    fixture.row.getBoundingClientRect = () => ({ top: 200, bottom: 230 });
    fixture.flush();
    assert.deepEqual(fixture.calls, []);
});

test('a row becoming clipped before the render frame is still revealed', () => {
    const fixture = new ScrollFixture();
    fixture.schedule();
    fixture.row.getBoundingClientRect = () => ({ top: 390, bottom: 420 });
    fixture.flush();
    assert.equal(fixture.calls.length, 1);
});

test('Locate preserves a fully visible row and centers only an out-of-view row', () => {
    for (const [top, bottom, expected] of [[200, 230, []], [390, 420, [{ id: 'selected', behavior: 'smooth', block: 'center' }]]]) {
        const fixture = new ScrollFixture(top, bottom);
        fixture.schedule({ contextRows: 0, block: 'center' }); fixture.flush();
        assert.deepEqual(fixture.calls, expected);
    }
});

test('hidden and disconnected rows cannot scroll the tree or outer document', () => {
    for (const state of ['disconnected', 'hidden-row', 'hidden-container']) {
        const fixture = new ScrollFixture(0, 0);
        fixture.schedule();
        if (state === 'disconnected') fixture.row.isConnected = false;
        if (state === 'hidden-row') fixture.row.getClientRects = () => [];
        if (state === 'hidden-container') fixture.container.clientHeight = 0;
        fixture.flush();
        assert.deepEqual(fixture.calls, [], state);
    }
});

test('first row can be revealed without assuming preceding siblings exist', () => {
    const fixture = new ScrollFixture(500, 530);
    fixture.row.previousElementSibling = null;
    fixture.schedule(); fixture.flush();
    assert.deepEqual(fixture.calls, [{ id: 'selected', behavior: 'smooth', block: 'start' }]);
});

test('context cannot push the selected row below a short viewport', () => {
    const fixture = new ScrollFixture(500, 530);
    fixture.container.clientHeight = 45;
    fixture.schedule(); fixture.flush();
    assert.deepEqual(fixture.calls, [{ id: 'selected', behavior: 'smooth', block: 'start' }]);
});
