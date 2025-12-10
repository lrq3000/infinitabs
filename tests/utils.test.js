// tests/utils.test.js

import { formatSessionTitle, parseSessionTitle, isWorkspaceTrivial, generateGuid } from '../src/utils.js';

describe('formatSessionTitle', () => {
    test('should append windowId to name', () => {
        expect(formatSessionTitle('My Session', 123)).toBe('My Session [windowId:123]');
    });

    test('should replace existing windowId', () => {
        expect(formatSessionTitle('My Session [windowId:456]', 123)).toBe('My Session [windowId:123]');
    });

    test('should not append windowId if not provided', () => {
        expect(formatSessionTitle('My Session', null)).toBe('My Session');
    });
});

describe('parseSessionTitle', () => {
    test('should parse name and windowId', () => {
        expect(parseSessionTitle('My Session [windowId:123]')).toEqual({
            name: 'My Session',
            windowId: 123
        });
    });

    test('should return null windowId if not present', () => {
        expect(parseSessionTitle('My Session')).toEqual({
            name: 'My Session',
            windowId: null
        });
    });

    test('should handle names with brackets', () => {
         expect(parseSessionTitle('My [Special] Session [windowId:123]')).toEqual({
            name: 'My [Special] Session',
            windowId: 123
        });
    });
});

describe('generateGuid', () => {
    test('should return a string', () => {
        const guid = generateGuid();
        expect(typeof guid).toBe('string');
    });

    test('should return a valid UUID', () => {
        const guid = generateGuid();
        expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
});

describe('isWorkspaceTrivial', () => {
    const mockState = {
        sessionsById: {
            'session-1': {
                logicalTabs: [
                    { url: 'https://google.com' },
                    { url: 'https://example.com' }
                ]
            },
            'session-2': {
                logicalTabs: [
                    { url: 'chrome://newtab/' }
                ]
            },
            'session-3': {
                logicalTabs: []
            }
        }
    };

    test('should return true if snapshot is null', () => {
        expect(isWorkspaceTrivial(null, mockState)).toBe(true);
    });

    test('should return true if sessions is empty', () => {
        expect(isWorkspaceTrivial({ sessions: [] }, mockState)).toBe(true);
    });

    test('should return false if multiple windows', () => {
        const snapshot = {
            sessions: [
                { sessionId: 'session-2' },
                { sessionId: 'session-2' }
            ]
        };
        expect(isWorkspaceTrivial(snapshot, mockState)).toBe(false);
    });

    test('should return true if single window with new tab', () => {
         const snapshot = {
            sessions: [
                { sessionId: 'session-2' }
            ]
        };
        expect(isWorkspaceTrivial(snapshot, mockState)).toBe(true);
    });

    test('should return true if single window with no tabs', () => {
         const snapshot = {
            sessions: [
                { sessionId: 'session-3' }
            ]
        };
        expect(isWorkspaceTrivial(snapshot, mockState)).toBe(true);
    });

    test('should return false if single window with real tabs', () => {
         const snapshot = {
            sessions: [
                { sessionId: 'session-1' }
            ]
        };
        expect(isWorkspaceTrivial(snapshot, mockState)).toBe(false);
    });
});
