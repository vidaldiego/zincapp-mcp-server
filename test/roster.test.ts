import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OfficeRoster, rosterConfigFromEnv } from '../src/tools/roster-office.js'

const week = '2026-11-23'
const reviewId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'

test('office roster is opt-in and its executable and profile come only from host configuration', () => {
    assert.equal(rosterConfigFromEnv({}), undefined)
    assert.throws(() => rosterConfigFromEnv({ ZINCAPP_ROSTER_PROFILE: 'office' }))
    assert.throws(() => rosterConfigFromEnv({ ZINCAPP_ROSTER_PROFILE: 'office', ZINCAPP_ROSTER_CLI: 'zincapi' }))
    const config = rosterConfigFromEnv({ ZINCAPP_ROSTER_PROFILE: 'office', ZINCAPP_ROSTER_CLI: '/safe/zincapi' })
    assert.equal(config?.profile, 'office')
})

test('reads use one fixed office profile and invalid draft IDs and scope get rejected', async () => {
    const calls: string[][] = []
    const rosters = new OfficeRoster({ executable: '/safe/zincapi', profile: 'office', stateDir: '/unused' }, async (_, args) => {
        calls.push(args)
        return { employees: [] }
    })
    await rosters.week({ week, employees: [7, 8], view: 'published' }, true)
    await assert.rejects(rosters.inspect('../outside', true))
    await assert.rejects(rosters.week({ week, employees: [7, 7] }, false))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], ['--profile=office', '--json', 'attendance', 'roster', 'pending', '--week=2026-11-23', '--employee-id=7,8', '--view=published'])
})

test('publishes only the exact recently rechecked review after human confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'office-roster-mcp-'))
    try {
        const calls: string[][] = []
        const identity = { companyId: 6, cif: 'B0000000X', actor: 'office' }
        const proposal = { query: { monday: week, employeeIds: [7] }, cohort: 'default', effectiveFrom: week, effectiveUntil: '2026-11-28' }
        const review = { reviewFingerprint: 'b'.repeat(64), identity, command: { action: 'PUBLISH', requestId, previewDigest: 'a'.repeat(64), reason: 'Test', proposal }, review: { blockers: [], changes: [{
            employeeId: 7, before: { date: week, status: 'PENDING', origin: 'NONE' },
            after: { date: week, status: 'ASSIGNED', origin: 'DRAFT', decision: 'SCHEDULE',
                model: { subject: 'early', versionId: reviewId }, expectedMinutes: 450 },
        }], sections: [] } }
        const receipt = { requestId, outcome: 'COMMITTED', kind: 'ROSTER_PUBLISH', revision: '3',
            resultRef: reviewId, employeeIds: [7], effectiveFrom: week, effectiveUntil: '2026-11-28' }
        const rosters = new OfficeRoster({ executable: '/safe/zincapi', profile: 'office', stateDir: directory }, async (_, args) => {
            calls.push(args)
            if (args.includes('--dry-run')) return review
            return receipt
        })
        await assert.rejects(rosters.apply(reviewId, 'publish', async () => false))
        assert.equal(calls.filter(args=>args.includes('--yes')).length, 0)
        const cancellation = new AbortController()
        await assert.rejects(rosters.apply(reviewId, 'publish', async () => {
            cancellation.abort()
            return true
        }, cancellation.signal))
        assert.equal(calls.filter(args => args.includes('--yes')).length, 0)
        const result = await rosters.apply(reviewId, 'publish', async message => {
            assert.ok(message.includes('empresa 6') && message.includes('2026-11-23'))
            assert.ok(message.includes(reviewId) && message.includes('450 min previstos') && message.includes('b'.repeat(64)))
            return true
        })
        assert.deepEqual(result, receipt)
        assert.equal(calls.filter(args=>args.includes('--yes')).length, 1)
        assert.ok(calls.at(-1)?.includes('--expect-review-sha256=' + 'b'.repeat(64)))
    } finally { await rm(directory, {recursive:true,force:true}) }
})

test('bulk assignment preserves typed IDs, days and decisions without filesystem inputs', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'office-roster-import-'))
    try {
        const calls: string[][] = []
        const bridge = new OfficeRoster({ executable: '/safe/zincapi', profile: 'office', stateDir }, async (_, args) => {
            calls.push(args)
            return { employees: [] }
        })
        const result = await bridge.importAssignments(reviewId, [{ employee: 7, days: [1, 2, 3], decision: 'REST' }])
        assert.notEqual(result.draftId, reviewId)
        assert.ok(calls[0].includes('--row=7;1,2,3;REST'))
        await assert.rejects(bridge.importAssignments(reviewId, [{ employee: 7, days: [6, 6], decision: 'REST' }]))
        assert.equal(calls.length, 1)
    } finally {
        await rm(stateDir, { recursive: true, force: true })
    }
})
