import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('기본 홈은 문서 없이 열리고, 문서에서 홈으로 갈 때 서버의 홈 설정을 따른다', async () => {
    const keys = ['window', 'document', 'history', 'setTimeout'];
    const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const noop = () => {};
    const node = () => {
        const classes = new Set();
        const attributes = new Map();
        return {
            classList: {
                add: value => classes.add(value),
                remove: value => classes.delete(value),
                contains: value => classes.has(value),
            },
            setAttribute: (key, value) => attributes.set(key, value),
            removeAttribute: key => attributes.delete(key),
            getAttribute: key => attributes.get(key),
            innerHTML: '',
            style: { setProperty: noop },
            querySelectorAll: () => [],
            querySelector: () => null,
        };
    };
    const ids = new Map(['loading', 'spaProgressBar', 'homePage', 'articlePage', 'deletedPage', 'privatePage', 'categoryPage'].map(id => [id, node()]));
    const homeLink = node();
    globalThis.document = {
        title: '읽던 문서',
        body: node(),
        documentElement: node(),
        addEventListener: noop,
        getElementById: id => ids.get(id) || null,
        querySelector: selector => selector === '[data-nav-page="home"]' ? homeLink : null,
        querySelectorAll: () => [],
    };
    globalThis.window = {
        location: { pathname: '/', search: '', origin: 'http://local', href: 'http://local/' },
        appConfig: { wikiName: '키즈위키' },
        addEventListener: noop,
        scrollTo: noop,
    };
    globalThis.history = { pushState: (_, __, url) => { window.location.pathname = new URL(url, window.location.origin).pathname; } };
    const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
    try {
        await server.ssrLoadModule('/src/client/pages/index.ts');
        globalThis.setTimeout = noop;
        await window.showHome();
        assert.equal(window.location.href, 'http://local/');
        assert.equal(document.title, '키즈위키');
        assert.equal(document.body.classList.contains('home-view'), true);
        assert.equal(ids.get('homePage').classList.contains('d-none'), false);
        assert.equal(ids.get('articlePage').classList.contains('d-none'), true);
        assert.equal(homeLink.getAttribute('aria-current'), 'page');

        window.location.pathname = '/w/읽던문서';
        await window.showHome();
        assert.equal(window.location.href, '/');
    } finally {
        for (const key of keys) {
            if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
            else delete globalThis[key];
        }
        await server.close();
    }
});
