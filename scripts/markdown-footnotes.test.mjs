import assert from 'node:assert/strict';
import test from 'node:test';
import { Marked } from 'marked';
import { createServer } from 'vite';

for (const path of ['/src/client/render.ts', '/packages/wiki-shared/src/render/render.ts']) {
    test(`${path}: 마크다운 각주`, async t => {
        const keys = ['window', 'document', 'marked'];
        const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        globalThis.window = { addEventListener() {} };
        globalThis.document = { readyState: 'loading', addEventListener() {} };
        globalThis.marked = new Marked();
        const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
        try {
            await server.ssrLoadModule(path);
            const parse = src => marked.parse(src);

            await t.test('뒤쪽 정의, 반복 참조, 여러 줄 설명과 인라인 서식', () => {
                const html = parse('본문[^1], 다시[^1].\n\n[^1]: **강조**와 [출처](https://example.com)\n    두 번째 줄\n\n다음 문단');
                assert.equal((html.match(/class="wiki-fn-marker"/g) || []).length, 2);
                assert.equal((html.match(/data-fn-name="md:1"/g) || []).length, 2);
                assert.match(html, /&lt;strong&gt;강조&lt;\/strong&gt;/);
                assert.match(html, /두 번째 줄/);
                assert.match(html, /<p>다음 문단<\/p>/);
                assert.doesNotMatch(html, /\[\^1\]:/);
            });

            await t.test('앞쪽 정의, 한글 이름, 중복 정의와 사용하지 않은 정의', () => {
                const html = parse('[^출처]: 첫 설명\n\n[^출처]: 중복 설명\n\n[^unused]: 숨겨진 설명\n\n본문[^출처]');
                assert.match(html, /data-fn-name="md:출처" data-fn-html="첫 설명"/);
                assert.doesNotMatch(html, /중복 설명|숨겨진 설명/);
            });

            await t.test('미정의 참조는 평문이며 다른 문서로 정의가 새지 않는다', () => {
                parse('[^1]: 이전 문서');
                assert.equal(parse('본문[^1]'), '<p>본문[^1]</p>\n');
            });

            await t.test('코드, 이스케이프, 일반 링크와 기존 위키 각주를 보존한다', () => {
                const html = parse('`[^1]` \\[^1] [^1](https://example.com) [*1 위키 설명] [^1]\n\n```md\n[^code]: 코드 설명\n```\n\n    [^indented]: 들여쓴 코드\n\n[^1]: 실제 설명');
                assert.equal((html.match(/class="wiki-fn-marker"/g) || []).length, 2);
                assert.match(html, /<code>\[\^1\]<\/code>/);
                assert.match(html, /<a href="https:\/\/example.com">\[?\^1\]?<\/a>/);
                assert.match(html, /data-fn-name="1"/);
                assert.match(html, /data-fn-name="md:1"/);
                assert.match(html, /\[\^code\]: 코드 설명/);
                assert.match(html, /\[\^indented\]: 들여쓴 코드/);
            });

            await t.test('설명 안의 참조 링크도 정의 순서와 관계없이 처리한다', () => {
                const html = parse('본문[^1]\n\n[^1]: [자료][source]\n\n[source]: https://example.com');
                assert.match(html, /&lt;a href=&quot;https:\/\/example.com&quot;&gt;자료&lt;\/a&gt;/);
            });

            await t.test('각주 내용과 이름은 HTML 속성을 탈출하지 못한다', () => {
                const html = parse('본문[^"onmouseover="x]\n\n[^"onmouseover="x]: <img src=x onerror=alert(1)>');
                assert.match(html, /data-fn-name="md:&quot;onmouseover=&quot;x"/);
                assert.doesNotMatch(html, /<img|" onmouseover=/);
            });

            await t.test('자기 참조와 순환 참조도 렌더링을 끝낸다', () => {
                assert.match(parse('본문[^a]\n\n[^a]: [^a]'), /wiki-fn-marker/);
                assert.match(parse('본문[^a]\n\n[^a]: [^b]\n\n[^b]: [^a]'), /wiki-fn-marker/);
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
