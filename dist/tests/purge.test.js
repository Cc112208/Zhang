import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestService } from './helpers.js';
test('purgeScope removes raw and derived records atomically within one scope', async () => {
    const { service, cleanup } = createTestService();
    try {
        const captured = service.capture({ content: '决定保留这个项目的记忆。', sourceType: 'manual' });
        const result = service.purgeScope(captured.scopeId);
        assert.equal(result.scopeId, captured.scopeId);
        assert.ok(result.deleted > 0);
        assert.equal(service.getExperience(captured.experience.id), null);
        assert.equal(service.getEpisode(captured.episode.id), null);
        assert.equal(service.status({ scopeId: captured.scopeId }).experiences, 0);
    }
    finally {
        cleanup();
    }
});
