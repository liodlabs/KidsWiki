import assert from 'node:assert/strict';
import test from 'node:test';
import { Marked } from 'marked';
import { createServer } from 'vite';

for (const path of ['/src/client/render.ts', '/packages/wiki-shared/src/render/render.ts']) {
    test(`${path}: 물결표와 취소선 경계`, async t => {
        const keys = ['window', 'document', 'marked'];
        const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        globalThis.window = { addEventListener() {} };
        globalThis.document = { readyState: 'loading', addEventListener() {} };
        globalThis.marked = new Marked();
        const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
        try {
            await server.ssrLoadModule(path);
            const parse = src => globalThis.marked.parse(src);

            await t.test('단어·숫자에 붙은 물결표와 띄어 쓴 물결표는 평문이다', () => {
                for (const src of ['여기서~부터', '여기서 ~ 부터', '여기서~부터~끝까지',
                    '여기서 ~ 부터 ~ 끝까지', '2235~2635파운드, 10~20kg',
                    '앞~이건 취소선~', '~이건 취소선~뒤', '~ 이건 취소선~', '~이건 취소선 ~']) {
                    assert.equal(parse(src), `<p>${src}</p>\n`, src);
                }
            });

            await t.test('단일 물결표는 바깥 경계와 안쪽 글자가 분명할 때만 취소선이다', () => {
                assert.equal(parse('~이건 취소선~'), '<p><del>이건 취소선</del></p>\n');
                assert.equal(parse('앞 ~이건 취소선~ 뒤'), '<p>앞 <del>이건 취소선</del> 뒤</p>\n');
                assert.equal(parse('“~취소선~”, (~한 글자~).'), '<p>“<del>취소선</del>”, (<del>한 글자</del>).</p>\n');
                assert.equal(parse('~한~'), '<p><del>한</del></p>\n');
                assert.equal(parse('~**강조**와 [링크](https://example.com)~'), '<p><del><strong>강조</strong>와 <a href="https://example.com">링크</a></del></p>\n');
            });

            await t.test('이중 물결표·코드·이스케이프·링크 주소는 기존대로 처리한다', () => {
                assert.equal(parse('앞~~취소선~~뒤'), '<p>앞<del>취소선</del>뒤</p>\n');
                assert.equal(parse('`~코드~` \\~평문\\~'), '<p><code>~코드~</code> ~평문~</p>\n');
                assert.equal(parse('[링크](https://example.com/a~b~c)'), '<p><a href="https://example.com/a~b~c">링크</a></p>\n');
                assert.match(parse('~~~md\n~코드~\n~~~'), /<code class="language-md">~코드~\n<\/code>/);
            });
        } finally {
            await server.close();
            for (const key of keys) {
                if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
                else delete globalThis[key];
            }
        }
    });
}
