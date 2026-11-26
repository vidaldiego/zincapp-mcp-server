import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { OfficePresencia } from '../src/tools/presencia-office.js'
import { registerOfficePresencia } from '../src/tools/presencia.js'

const { ConfigurationChange, AssistedPunch } = JSON.parse(await readFile('test/fixtures/presencia-b0-b2.json', 'utf8'))
const requestId = AssistedPunch.requestId
const identity = { companyId: 42, cif: 'B12345678', userName: 'office-user', apiBaseUrl: 'https://api.example.test' }
const review = {
    requestId, kind: 'ASSISTED_PUNCH', employeeId: 17, workDate: '2026-11-26',
    revision: 'revision-2', digest: 'a'.repeat(64), proof: 'synthetic-opaque-proof',
    expiresAt: '2026-11-26T10:00:00Z', proposal: AssistedPunch,
}
const workDate = '2026-11-26'
const when = '2026-11-26T07:00:00Z'
const solicitudId = '96c9f542-e0dc-4e47-ba79-68df22c87616'
const movementId = '196e77b0-8e64-41a9-a723-23280787bb29'
const schedule = { kind: 'SHIFT', zone: 'Europe/Madrid', start: when, end: '2026-11-26T15:00:00Z' }
const movement = { action: 'ENTRY', at: when, place: { kind: 'CENTER', clientId: 0, centerId: 0 } }
const correction = {
    requestId, expectedRevision: review.revision, reason: 'Entrada omitida', change: { kind: 'ADD', movement },
}
const dayRequest = {
    id: solicitudId, employeeId: 17, workDate, reason: 'Falta la entrada', createdAt: when, status: 'PENDING',
}

async function setup(t: TestContext, response: unknown, envelope?: unknown, cliError?: string) {
    const directory = await mkdtemp(join(tmpdir(), "zincapp-presencia-'"))
    t.after(() => rm(directory, { recursive: true }))
    const executable = join(directory, 'zincapi')
    const stateDir = join(directory, 'presencia')
    const callsPath = join(directory, 'calls')
    const fakeCLI = `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const flag = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
const input = flag('input') ? JSON.parse(readFileSync(flag('input'), 'utf8')) : null
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, input }) + '\\n')
const error = ${JSON.stringify(cliError ?? null)}
if (error) {
    console.error(error)
    process.exit(1)
}
const envelope = ${JSON.stringify(envelope ?? null)}
if (envelope && flag('output')) writeFileSync(flag('output'), JSON.stringify(envelope), { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify(${JSON.stringify(response)}))
`
    await writeFile(executable, fakeCLI, { mode: 0o700 })
    const server = new McpServer({ name: 'office', version: '1.0.0' })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    registerOfficePresencia(server, new OfficePresencia({ executable, profile: 'trusted-office', stateDir }))
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    t.after(() => client.close())
    return {
        async call(name: string, args: Record<string, unknown>) {
            const response = await client.callTool({ name: 'attendance_presencia_' + name, arguments: args })
            const components = response.content as { text?: string }[]
            const text = components[0]?.text ?? ''
            return response.isError ? { error: text } : { data: JSON.parse(text) }
        },
        async calls() {
            return await readFile(callsPath, 'utf8').then(raw => raw.trim().split('\n').map(line => JSON.parse(line)))
        },
        stateDir,
    }
}

test('reads configuration for the selected employee using the fixed CLI profile', async t => {
    const configuration = {
        employeeId: 17, revision: 'revision-2',
        periods: [{ effectiveFrom: '2026-11-26', mode: 'VOLUNTARY', allowRemote: true, requireGps: true, centers: [] }],
    }
    const { call, calls } = await setup(t, configuration)
    assert.deepEqual(await call('configuration_get', { employeeId: 17 }), { data: configuration })
    assert.deepEqual(await calls(), [{ args: [
        '--profile=trusted-office', '--json', 'attendance', 'presencia', 'configuration', 'get', '--employee-id=17',
    ], input: null }])
})

test('prepares an exact configuration proposal with a private interactive handoff', async t => {
    const configured = { ...review, kind: 'CONFIGURE', proposal: ConfigurationChange }
    const { call, calls } = await setup(t, configured, { schemaVersion: 1, identity, review: configured })
    const result = await call('configuration_preview', { employeeId: 17, change: ConfigurationChange })
    const { proof, ...visible } = configured
    assert.deepEqual(result.data.review, visible)
    assert.equal(result.data.identity.companyId, 42)
    assert.equal(result.data.identity.userName, 'office-user')
    assert.match(result.data.terminalCommand, /attendance presencia configuration apply --proposal=/)
    assert.ok(result.data.terminalCommand.includes("'\"" + "'\"" + "'"))
    assert.doesNotMatch(JSON.stringify(result.data), /synthetic-opaque-proof|--yes/)
    const { proposalPath } = result.data
    assert.equal((await lstat(proposalPath)).mode & 0o777, 0o600)
    assert.equal((await lstat(dirname(proposalPath))).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(dirname(proposalPath)), ['proposal.json'])
    assert.deepEqual(await calls(), [{ args: [
        '--profile=trusted-office', '--json', 'attendance', 'presencia', 'configuration', 'preview', '--employee-id=17',
        '--input=' + join(dirname(proposalPath), 'input.json'), '--output=' + proposalPath,
    ], input: ConfigurationChange }])
})

test('preserves the exact subject, center, action and reason on assisted preview', async t => {
    const { call, calls } = await setup(t, review, { schemaVersion: 1, identity, review })
    const result = await call('assist_preview', { punch: AssistedPunch })
    assert.deepEqual(result.data.review.proposal, AssistedPunch)
    assert.match(result.data.terminalCommand, /attendance presencia assist apply --proposal=/)
    const [command] = await calls()
    assert.deepEqual(command.args.slice(0, 6), ['--profile=trusted-office', '--json', 'attendance', 'presencia', 'assist', 'preview'])
    assert.deepEqual(command.input, AssistedPunch)
})

test('preserves the default company center when previewing a punch', async t => {
    const punch = { ...AssistedPunch, place: { kind: 'CENTER', clientId: 0, centerId: 0 } }
    const localReview = { ...review, proposal: punch }
    const { call, calls } = await setup(t, localReview, { schemaVersion: 1, identity, review: localReview })
    const result = await call('assist_preview', { punch })
    assert.deepEqual(result.data?.review.proposal.place, { kind: 'CENTER', clientId: 0, centerId: 0 })
    assert.deepEqual((await calls())[0].input.place, { kind: 'CENTER', clientId: 0, centerId: 0 })
})

test('rejects GPS and caller-supplied CLI overrides before any child process', async t => {
    const { call, calls } = await setup(t, review)
    assert.ok((await call('assist_preview', { punch: { ...AssistedPunch, gps: {} } })).error)
    assert.ok((await call('assist_preview', { punch: { ...AssistedPunch, place: { kind: 'REMOTE', latitude: 12 } } })).error)
    assert.ok((await call('assist_preview', { punch: AssistedPunch, executable: '/some/other/zincapi', yes: true })).error)
    assert.ok((await call('configuration_get', { employeeId: 17, profile: 'other' })).error)
    assert.ok((await call('configuration_preview', { employeeId: 17, change: { ...ConfigurationChange, effectiveFrom: '2026-02-30' } })).error)
    await assert.rejects(calls, { code: 'ENOENT' })
})

test('discards a handoff whose saved review differs from the one returned by the CLI', async t => {
    const { call, stateDir } = await setup(t, review, {
        schemaVersion: 1, identity, review: { ...review, digest: 'b'.repeat(64) },
    })
    assert.ok((await call('assist_preview', { punch: AssistedPunch })).error)
    assert.deepEqual(await readdir(stateDir), [])
})

test('rejects an existing proposal root with access for other local users', async t => {
    const { call, calls, stateDir } = await setup(t, review)
    await mkdir(stateDir, { mode: 0o755 })
    assert.ok((await call('assist_preview', { punch: AssistedPunch })).error)
    await assert.rejects(calls, { code: 'ENOENT' })
})

for (const outcome of ['NOT_OBSERVED', 'CONFIRMED', 'REJECTED', 'CANCELLED']) {
    test(`A9 returns ${outcome} in a single result lookup`, async t => {
        const receipt = { requestId, outcome, kind: outcome === 'NOT_OBSERVED' ? null : 'ASSISTED_PUNCH' }
        const { call, calls } = await setup(t, receipt)
        assert.deepEqual(await call('operation', { requestId }), { data: receipt })
        assert.deepEqual(await calls(), [{ args: [
            '--profile=trusted-office', '--json', 'attendance', 'presencia', 'operation', 'get', '--request-id=' + requestId,
        ], input: null }])
    })
}

test('rejects a receipt returned for a different UUID', async t => {
    const { call } = await setup(t, { requestId: '96c9f542-e0dc-4e47-ba79-68df22c87616', outcome: 'CONFIRMED' })
    assert.ok((await call('operation', { requestId })).error)
})

test('authorization and transient CLI errors remain errors without exposing stderr', async t => {
    for (const code of [403, 409, 503]) {
        const { call } = await setup(t, null, `unused`, `HTTP ${code}: sensitive-session-detail`)
        const { error } = await call('operation', { requestId })
        assert.match(error ?? '', new RegExp(String(code)))
        assert.doesNotMatch(error ?? '', /sensitive-session-detail|REJECTED/)
    }
})

test('lists office days with the exact date, filters and opaque cursor', async t => {
    const result = {
        date: workDate, zone: 'Europe/Madrid', asOf: when,
        rows: [{ employeeId: 17, name: 'Empleado de prueba', status: 'MISSING', schedule, pendingRequests: 1 }],
        counts: { total: 4, byStatus: { MISSING: 4 } }, nextCursor: 'page-2',
    }
    const { call, calls } = await setup(t, result)
    assert.deepEqual(await call('days_list', {
        date: workDate, q: 'Empleado', clientId: 0, centerId: 0, view: 'REQUESTS', status: 'MISSING',
        cursor: 'opaque+/=', limit: 25,
    }), { data: result })
    assert.deepEqual(await calls(), [{ args: [
        '--profile=trusted-office', '--json', 'attendance', 'presencia', 'days', 'list',
        '--date=' + workDate, '--q=Empleado', '--client-id=0', '--center-id=0',
        '--view=REQUESTS', '--status=MISSING', '--cursor=opaque+/=', '--limit=25',
    ], input: null }])
})

test('returns the complete office day for the exact person and logical date', async t => {
    const result = {
        employeeId: 17, name: 'Empleado de prueba', workDate, zone: 'Europe/Madrid', revision: review.revision,
        status: 'WORKING', schedule, totals: { confirmedMs: 0, provisionalMs: 3600000, breakMs: 0 },
        movements: [{ id: movementId, ...movement, origin: 'OWN_PUNCH', effective: false }],
        corrections: [{
            id: requestId, kind: 'VOID', reason: 'Movimiento duplicado', createdAt: when, createdBy: 'office-user',
            active: true, targetPunchId: movementId,
        }],
        requests: [dayRequest], capabilities: { correct: true, resolve: false },
        placeLabels: [{ clientId: 0, centerId: 0, name: 'Centro principal' }],
    }
    const { call, calls } = await setup(t, result)
    assert.deepEqual(await call('days_get', { employeeId: 17, date: workDate }), { data: result })
    assert.deepEqual((await calls())[0].args.slice(4), ['days', 'get', '--employee-id=17', '--date=' + workDate])
    assert.ok((await call('days_get', { employeeId: 18, date: workDate })).error)
    assert.ok((await call('days_get', { employeeId: 17, date: '2026-11-25' })).error)

    const { placeLabels, ...withoutLabels } = result
    const older = await setup(t, withoutLabels)
    assert.deepEqual(await older.call('days_get', { employeeId: 17, date: workDate }), { data: withoutLabels })

    const withExtraData = await setup(t, {
        ...result, placeLabels: [{ ...placeLabels[0], proof: review.proof }],
    })
    const rejected = await withExtraData.call('days_get', { employeeId: 17, date: workDate })
    assert.ok(rejected.error)
    assert.doesNotMatch(JSON.stringify(rejected), /synthetic-opaque-proof/)
})

test('lists office requests through the fixed profile', async t => {
    const result = { rows: [dayRequest], nextCursor: null }
    const { call, calls } = await setup(t, result)
    assert.deepEqual(await call('requests_list', {
        date: workDate, employeeId: 17, status: 'PENDING', limit: 1,
    }), { data: result })
    assert.deepEqual(await calls(), [{ args: [
        '--profile=trusted-office', '--json', 'attendance', 'presencia', 'requests', 'list',
        '--date=' + workDate, '--employee-id=17', '--status=PENDING', '--limit=1',
    ], input: null }])
})

test('prepares a correction privately and exposes the normalized review without the proof', async t => {
    const input = { ...correction, reason: ' Entrada omitida ', change: {
        kind: 'ADD', movement: { ...movement, at: '2026-11-26T07:00:00.000000000Z' },
    } }
    const reviewed = { ...review, kind: 'CORRECTION', proposal: correction }
    const { call, calls } = await setup(t, reviewed, { schemaVersion: 1, identity, review: reviewed })
    const result = await call('correction_preview', { employeeId: 17, date: workDate, correction: input })
    const { proof, ...visible } = reviewed
    assert.deepEqual(result.data?.review, visible)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-opaque-proof|--yes/)
    const { proposalPath, terminalCommand } = result.data
    assert.match(terminalCommand, /attendance presencia correction apply --proposal=/)
    assert.equal((await lstat(proposalPath)).mode & 0o777, 0o600)
    assert.equal((await lstat(dirname(proposalPath))).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(dirname(proposalPath)), ['proposal.json'])
    assert.deepEqual(await calls(), [{ args: [
        '--profile=trusted-office', '--json', 'attendance', 'presencia', 'correction', 'preview',
        '--employee-id=17', '--date=' + workDate,
        '--input=' + join(dirname(proposalPath), 'input.json'), '--output=' + proposalPath,
    ], input }])
})

test('prepares request resolution for the exact request, person and date', async t => {
    const resolution = { ...correction, decision: 'APPROVED' }
    const reviewed = { ...review, kind: 'REQUEST_RESOLVE', proposal: { ...resolution, solicitudId } }
    const { call, calls } = await setup(t, reviewed, { schemaVersion: 1, identity, review: reviewed })
    const result = await call('resolution_preview', { solicitudId, employeeId: 17, date: workDate, resolution })
    const { proof, ...visible } = reviewed
    assert.deepEqual(result.data?.review, visible)
    assert.match(result.data?.terminalCommand, /attendance presencia resolution apply --proposal=/)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-opaque-proof|--yes/)
    assert.deepEqual((await calls())[0].args.slice(4, 9),
        ['resolution', 'preview', '--solicitud-id=' + solicitudId, '--employee-id=17', '--date=' + workDate])
    assert.deepEqual((await calls())[0].input, resolution)
})

test('rejects unsafe or invalid B3 input before invoking the CLI', async t => {
    const { call, calls } = await setup(t, null)
    assert.ok((await call('days_list', { clientId: 0 })).error)
    assert.ok((await call('days_list', { centerId: 0 })).error)
    assert.ok((await call('days_list', { view: 'WRONG' })).error)
    assert.ok((await call('days_list', { limit: 101 })).error)
    assert.ok((await call('requests_list', { date: '2026-02-30' })).error)
    assert.ok((await call('days_get', { employeeId: 17, date: workDate, profile: 'other' })).error)
    assert.ok((await call('correction_preview', {
        employeeId: 17, date: workDate, correction: {
            ...correction, change: { kind: 'ADD', movement: { ...movement, gps: { latitude: 0, longitude: 0 } } },
        },
    })).error)
    for (const at of ['2026-11-26T07:00Z', '2026-11-26T07:00:00.0001Z']) {
        assert.ok((await call('correction_preview', {
            employeeId: 17, date: workDate, correction: {
                ...correction, change: { kind: 'ADD', movement: { ...movement, at } },
            },
        })).error)
    }
    const { change, ...withoutChange } = correction
    assert.ok((await call('resolution_preview', {
        solicitudId, employeeId: 17, date: workDate, resolution: { ...withoutChange, decision: 'APPROVED' },
    })).error)
    assert.ok((await call('resolution_preview', {
        solicitudId, employeeId: 17, date: workDate, resolution: { ...correction, decision: 'REJECTED' },
    })).error)
    await assert.rejects(calls, { code: 'ENOENT' })
})

test('discards a correction whose returned preview changes the movement', async t => {
    const reviewed = { ...review, kind: 'CORRECTION', proposal: {
        ...correction, change: { kind: 'ADD', movement: { ...movement, at: '2026-11-26T08:00:00Z' } },
    } }
    const { call, stateDir } = await setup(t, reviewed, { schemaVersion: 1, identity, review: reviewed })
    const result = await call('correction_preview', { employeeId: 17, date: workDate, correction })
    assert.ok(result.error)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-opaque-proof/)
    assert.deepEqual(await readdir(stateDir), [])
})

test('prepares a rejection without a correction or another write', async t => {
    const { change, ...withoutChange } = correction
    const resolution = { ...withoutChange, decision: 'REJECTED' }
    const reviewed = { ...review, kind: 'REQUEST_RESOLVE', proposal: { ...resolution, solicitudId } }
    const { call, calls } = await setup(t, reviewed, { schemaVersion: 1, identity, review: reviewed })
    const result = await call('resolution_preview', { solicitudId, employeeId: 17, date: workDate, resolution })
    assert.equal(result.data?.review.proposal.decision, 'REJECTED')
    assert.doesNotMatch(JSON.stringify(result), /"change"|synthetic-opaque-proof|--yes/)
    const commandList = await calls()
    assert.equal(commandList.length, 1)
    assert.equal(commandList[0].args[5], 'preview')
})

test('discards mismatched B3 resolutions without leaking private review data in errors', async t => {
    const { change, ...withoutChange } = correction
    const resolution = { ...withoutChange, decision: 'REJECTED' }
    const reviewed = {
        ...review, kind: 'REQUEST_RESOLVE', proposal: { ...resolution, solicitudId: movementId },
    }
    const { call, stateDir } = await setup(t, reviewed, { schemaVersion: 1, identity, review: reviewed })
    const result = await call('resolution_preview', { solicitudId, employeeId: 17, date: workDate, resolution })
    assert.ok(result.error)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-opaque-proof/)
    assert.deepEqual(await readdir(stateDir), [])
})

test('traps extra fields on B3 CLI results without exposing them', async t => {
    const { call } = await setup(t, { rows: [{ ...dayRequest, proof: review.proof }] })
    const rejected = await call('requests_list', {})
    assert.ok(rejected.error)
    assert.doesNotMatch(JSON.stringify(rejected), /synthetic-opaque-proof/)
})

test('recovers B3 receipts by operation UUID without a write or retry', async t => {
    for (const kind of ['CORRECTION', 'REQUEST_CREATE', 'REQUEST_RESOLVE']) {
        const receipt = { requestId, outcome: 'CONFIRMED', kind, employeeId: 17, workDate }
        const { call, calls } = await setup(t, receipt)
        assert.deepEqual(await call('operation', { requestId }), { data: receipt })
        assert.deepEqual(await calls(), [{ args: [
            '--profile=trusted-office', '--json', 'attendance', 'presencia', 'operation', 'get', '--request-id=' + requestId,
        ], input: null }])
    }
})
