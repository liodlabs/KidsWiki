import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('승인 도구는 항상 포함하고 즉시 반영을 켜면 apply_edit과 revert_page를 추가 노출한다', async () => {
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
    try {
        const { getUserToolDefs } = await server.ssrLoadModule('/src/routes/mcp.ts');
        const off = getUserToolDefs(false).map(({ name }) => name);
        const on = getUserToolDefs(true).map(({ name }) => name);

        assert.ok(off.includes('create_or_update_page'));
        assert.ok(off.includes('commit_edit'));
        for (const name of ['list_submissions', 'read_submission', 'approve_submission', 'reject_submission']) {
            assert.ok(off.includes(name));
            assert.ok(on.includes(name));
        }
        assert.equal(off.includes('apply_edit'), false);
        assert.equal(off.includes('revert_page'), false);
        assert.ok(on.includes('apply_edit'));
        assert.ok(on.includes('revert_page'));
    } finally {
        await server.close();
    }
});
