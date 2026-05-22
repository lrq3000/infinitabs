const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createClassList() {
    return {
        removed: [],
        remove(...classNames) {
            this.removed.push(...classNames);
        }
    };
}

function createElementStub(id) {
    return {
        id,
        addEventListener() {},
        classList: createClassList(),
        style: {},
        dataset: {},
        children: [],
        appendChild(child) {
            this.children.push(child);
        },
        querySelector() {
            return createElementStub(`${id}-child`);
        }
    };
}

function runSidebarScenario(scenarioScript) {
    const sidebarPath = path.join(__dirname, '..', 'src', 'sidebar.js');
    const sidebarSource = fs.readFileSync(sidebarPath, 'utf8')
        .replace("import { parseGroupTitle } from './utils.js';", "function parseGroupTitle(title) { return { name: title, color: 'grey' }; }")
        .replace(/\/\/ Start\s*init\(\);\s*$/m, '// Start disabled in VM tests');

    const context = {
        console,
        setTimeout,
        clearTimeout,
        localStorage: {
            getItem() { return null; },
            setItem() {},
            removeItem() {}
        },
        document: {
            body: createElementStub('body'),
            getElementById(id) {
                return createElementStub(id);
            },
            createElement(tagName) {
                return createElementStub(tagName);
            },
            addEventListener() {},
            querySelectorAll() {
                return [];
            }
        },
        window: {
            requestAnimationFrame(callback) {
                callback();
            }
        },
        chrome: {
            runtime: {
                getURL(pathName) {
                    return pathName;
                },
                openOptionsPage() {},
                onMessage: { addListener() {} },
                sendMessage(message) {
                    context.__messages.push(message);
                    return Promise.resolve({});
                }
            },
            windows: {
                getCurrent() {
                    return Promise.resolve({ id: 1 });
                }
            },
            storage: {
                local: {
                    get(defaults, callback) {
                        callback(defaults);
                    },
                    set(_items, callback) {
                        if (callback) callback();
                    }
                },
                onChanged: { addListener() {} }
            }
        },
        __messages: [],
        __results: null
    };

    vm.createContext(context);
    vm.runInContext(`${sidebarSource}\n${scenarioScript}`, context, { filename: 'sidebar-quick-drag.vm.js' });
    return context.__results;
}

function runTest() {
    console.log('Starting test_sidebar_quick_drag.js...');

    const result = runSidebarScenario(`
        const dragStartClassList = { added: [], add(...classNames) { this.added.push(...classNames); } };
        const dragStartRoot = { dataset: { type: 'tab', id: 'tab-start-1' }, classList: dragStartClassList };
        const dragStartChildTarget = { dataset: {}, classList: { add() {} } };
        const fakeDataTransfer = { effectAllowed: '', setData() {} };

        // onDragStart should read dataset/classList from the draggable root, not from child targets.
        onDragStart({ currentTarget: dragStartRoot, target: dragStartChildTarget, dataTransfer: fakeDataTransfer });

        const rootClassList = { removed: [], remove(...classNames) { this.removed.push(...classNames); } };
        const tabRoot = { dataset: { type: 'tab', id: 'tab-1' }, classList: rootClassList };
        const childTarget = { dataset: {} };
        let childTargetThrew = false;

        Date.now = () => 1000;
        dragStartTime = 900;

        try {
            onDragEnd({ currentTarget: tabRoot, target: childTarget });
        } catch (error) {
            childTargetThrew = true;
        }

        const messagesAfterChildTarget = __messages.slice();
        const removedAfterChildTarget = rootClassList.removed.slice();

        // A second quick-looking dragend without a matching dragstart must not reuse stale timing state.
        const secondRootClassList = { removed: [], remove(...classNames) { this.removed.push(...classNames); } };
        const secondTabRoot = { dataset: { type: 'tab', id: 'tab-2' }, classList: secondRootClassList };
        Date.now = () => 1100;
        onDragEnd({ currentTarget: secondTabRoot, target: secondTabRoot });

        __results = {
            dragStartAddedClasses: dragStartClassList.added.slice(),
            childTargetThrew,
            removedAfterChildTarget,
            messagesAfterChildTarget,
            allMessages: __messages.slice()
        };
    `);

    assert.deepStrictEqual(Array.from(result.dragStartAddedClasses), ['dragging'], 'dragstart should add dragging on the draggable root even when the event target is a child');
    assert.strictEqual(result.childTargetThrew, false, 'dragend should use the draggable root when the event target is a child');
    assert.deepStrictEqual(Array.from(result.removedAfterChildTarget), ['dragging'], 'dragend should clear dragging from the draggable root');
    assert.strictEqual(result.messagesAfterChildTarget.length, 1, 'a quick tab drag should synthesize exactly one tab click');
    assert.strictEqual(result.messagesAfterChildTarget[0].logicalId, 'tab-1', 'the synthesized click should use the tab root logical ID');
    assert.strictEqual(result.allMessages.length, 1, 'dragStartTime should reset so a later dragend cannot reuse stale quick-drag state');

    console.log('test_sidebar_quick_drag.js passed.');
}

runTest();
