import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { OfficeRosterWeek } from '../src/tools/roster-week-office.js'
import { registerOfficeRosterWeek } from '../src/tools/roster-week.js'

const monday = '2026-11-23'
const saturday = '2026-11-28'
const requestId = '96018171-213e-4939-aaaa-9d9ea390d870'
const center = { clientId: 0, centerId: 0 }
const identity = { companyId: 42, cif: 'B12345678', userName: 'office-user', apiBaseUrl: 'https://api.example.test' }
const intent = {
    requestId, action: 'PUBLISH', draftRevision: 4, publishedRevision: 2,
    cells: [
        { employeeId: 17, date: monday, choice: 'SHIFT', shiftId: '4:21', plannedCenter: center,
            section: 'Taller', paidBreakMinutes: 15, unpaidBreakMinutes: 30 },
        { employeeId: 17, date: '2026-11-25', choice: 'REST' },
        { employeeId: 17, date: saturday, choice: 'PENDING' },
    ],
}
const pending = {
    kind: 'PENDING', zone: 'Europe/Madrid', paidBreakMinutes: 0, unpaidBreakMinutes: 0,
    start: null, end: null, plannedCenter: null,
}
const visible = {
    requestId, action: intent.action, monday, draftRevision: 4, publishedRevision: 2,
    digest: 'a'.repeat(64), expiresAt: '2026-11-23T08:00:00Z', blockers: [],
    changes: [
        { employeeId: 17, date: monday, before: null, after: {
            ...pending, kind: 'SHIFT', plannedCenter: center, start: '2026-11-23T07:00:00Z', end: '2026-11-23T15:00:00Z',
            section: 'Taller', paidBreakMinutes: 15, unpaidBreakMinutes: 30,
        } },
        { employeeId: 17, date: '2026-11-25', before: null, after: { ...pending, kind: 'REST' } },
        { employeeId: 17, date: saturday, before: null, after: pending },
    ],
}
const envelope = { schemaVersion: 1, identity, intent, review: { ...visible, proof: 'synthetic-private-proof' } }
const dates = [monday, '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', saturday, '2026-11-29']
const people = [{
    employeeId: 17, name: 'Empleado Sintético',
    cells: dates.map(date => ({ date, draft: null, published: date === saturday ? pending : null, constraint: null })),
}]
const shifts = [{ id: '4:21', name: 'Mañana', start: '08:00', end: '16:00' }]
const week = {
    monday, zone: 'Europe/Madrid', draftRevision: 4, publishedRevision: 2, copyFromMonday: '2026-11-16',
    canEdit: true, nextAfterEmployeeId: null, people, shifts, centers: [{ ...center, name: 'Centro de prueba' }],
}
const pdfBytes = '%PDF-1.7\n%%EOF\n'
const pdfMetadata = { monday, revision: 2, filename: 'cuadrante-2026-11-23-r2.pdf', bytes: Buffer.byteLength(pdfBytes) }

async function setup(t: TestContext, options: { response?: unknown, envelope?: unknown, pdf?: string, error?: string } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "zincapp-roster-week-'"))
    t.after(() => rm(directory, { recursive: true }))
    const executable = join(directory, 'zincapi')
    const stateDir = join(directory, 'roster')
    const callsPath = join(directory, 'calls')
    const fakeCLI = `#!${process.execPath}
const { appendFileSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
const flag = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
const inputPath = flag('input')
const input = inputPath ? JSON.parse(readFileSync(inputPath, 'utf8')) : null
const inputMode = inputPath ? statSync(inputPath).mode & 0777 : null
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, input, inputMode }) + '\\n')
const error = ${JSON.stringify(options.error ?? null)}
if (error) {
    console.error(error)
    process.exit(1)
}
const artifact = ${JSON.stringify(options.pdf ?? (options.envelope ? JSON.stringify(options.envelope) : null))}
if (artifact !== null && flag('output')) writeFileSync(flag('output'), artifact, { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify(${JSON.stringify(options.response ?? null)}))
`
    await writeFile(executable, fakeCLI, { mode: 0o700 })
    const server = new McpServer({ name: 'office', version: '1.0.0' })
    const client = new Client({ name: 'test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    registerOfficeRosterWeek(server, new OfficeRosterWeek({ executable, profile: 'trusted-office', stateDir }))
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    t.after(() => client.close())
    return {
        client,
        async call(name: string, args: Record<string, unknown>) {
            const response = await client.callTool({ name: 'attendance_roster_week_' + name, arguments: args })
            const text = (response.content as { text?: string }[])[0]?.text ?? ''
            return response.isError ? { error: text } : { data: JSON.parse(text) }
        },
        async calls() {
            return readFile(callsPath, 'utf8')
                .then(raw => raw.trim().split('\n').map(line => JSON.parse(line)))
                .catch(error => { if (error.code === 'ENOENT') return []; throw error })
        },
        stateDir,
    }
}

test('lists the exact people and revisions returned for the authorized week', async t => {
    const { call, calls } = await setup(t, { response: week })
    assert.deepEqual(await call('get', { week: monday, employeeIds: [17, 19], limit: 30, search: 'sintético' }), { data: week })
    assert.deepEqual((await calls()).map(call => call.args), [
        ['--profile=trusted-office', '--json', 'attendance', 'roster', 'week', 'show', '--week=' + monday,
            '--employee-id=17', '--employee-id=19', '--search=sintético', '--limit=30'],
    ])
})

test('lists the authorized catalogues and the exact pending dates', async t => {
    for (const [verb, response] of Object.entries({
        people, shifts, pending: [{ employeeId: 17, name: people[0].name, dates: [saturday] }],
    })) {
        const { call, calls } = await setup(t, { response })
        assert.deepEqual(await call(verb, { week: monday }), { data: response })
        assert.equal((await calls())[0].args[5], verb)
    }
})

test('can show pending dates from the published revision', async t => {
    const pendingPeople = [{ employeeId: 17, name: people[0].name, dates: [saturday] }]
    const { call, calls } = await setup(t, { response: pendingPeople })
    assert.deepEqual(await call('pending', { week: monday, view: 'published' }), { data: pendingPeople })
    assert.ok((await calls())[0].args.includes('--view=published'))
})

test('prepares a private CLI handoff for the exact cells in a client without confirmation capability', async t => {
    const { call, calls, client } = await setup(t, { response: visible, envelope })
    const tools = await client.listTools()
    assert.ok(!tools.tools.some(tool => /attendance_roster_week_(save|publish|apply)/.test(tool.name)))
    const result = await call('preview', { week: monday, intent })
    assert.equal(result.error, undefined)
    assert.deepEqual(result.data.review, visible)
    assert.equal(result.data.identity.companyId, 42)
    assert.match(result.data.terminalCommand, /attendance roster week publish --proposal=/)
    assert.doesNotMatch(JSON.stringify(result.data), /synthetic-private-proof|--yes|https:\/\/api.example.test/)
    assert.equal((await lstat(result.data.proposalPath)).mode & 0o777, 0o600)
    assert.equal((await lstat(dirname(result.data.proposalPath))).mode & 0o777, 0o700)
    assert.deepEqual(await readdir(dirname(result.data.proposalPath)), ['proposal.json'])
    const [preview] = await calls()
    assert.deepEqual(preview.input, intent)
    assert.equal(preview.inputMode, 0o600)
    assert.equal(preview.args[5], 'preview')
})

test('returns blockers for a copy proposal without writing a confirmable file', async t => {
    const copy = { ...intent, action: 'SAVE_DRAFT', copyFromMonday: '2026-11-16',
        cells: [{ employeeId: 17, date: saturday, choice: 'COPY' }] }
    const blocked = {
        ...visible, action: copy.action, changes: [], expiresAt: null,
        blockers: [{ employeeId: 17, date: saturday, code: 'PRESENCIA_ROSTER_COPY_REVIEW_REQUIRED' }],
    }
    const { call, calls, stateDir } = await setup(t, { response: blocked })
    assert.deepEqual(await call('preview', { week: monday, intent: copy }), { data: { review: blocked } })
    assert.deepEqual(await readdir(stateDir), [])
    assert.deepEqual((await calls())[0].input, copy)
})

test('returns missing weekdays for the same employee outside a partial publication', async t => {
    const blocked = {
        ...visible, expiresAt: null,
        blockers: [{ employeeId: 17, date: '2026-11-24', code: 'PRESENCIA_ROSTER_PENDING_WEEKDAY' }],
    }
    const { call, stateDir } = await setup(t, { response: blocked })
    assert.deepEqual(await call('preview', { week: monday, intent }), { data: { review: blocked } })
    assert.deepEqual(await readdir(stateDir), [])
})

test('rejects diagnostic blockers for people outside the requested publication', async t => {
    const blocked = {
        ...visible, expiresAt: null,
        blockers: [{ employeeId: 18, date: '2026-11-24', code: 'PRESENCIA_ROSTER_PENDING_WEEKDAY' }],
    }
    const { call, stateDir } = await setup(t, { response: blocked })
    assert.match((await call('preview', { week: monday, intent })).error ?? '', /revisión.*solicitada/)
    assert.deepEqual(await readdir(stateDir), [])
})

test('refuses a private proposal if its digest or selection changed', async t => {
    for (const saved of [
        { ...envelope, review: { ...envelope.review, digest: 'b'.repeat(64) } },
        { ...envelope, intent: { ...intent, cells: intent.cells.slice(1) } },
    ]) {
        const { call, stateDir } = await setup(t, { response: visible, envelope: saved })
        const output = await call('preview', { week: monday, intent })
        assert.match(output.error ?? '', /propuesta.*revisión/)
        assert.doesNotMatch(JSON.stringify(output), /synthetic-private-proof/)
        assert.deepEqual(await readdir(stateDir), [])
    }
})

test('rejects out-of-week and repeated cells before invoking the CLI', async t => {
    const { call, calls } = await setup(t)
    for (const cells of [
        [...intent.cells, intent.cells[0]],
        [...intent.cells, { employeeId: 17, date: '2026-11-30', choice: 'REST' }],
    ]) {
        const response = await call('preview', { week: monday, intent: { ...intent, cells } })
        assert.ok(response.error)
    }
    assert.deepEqual(await calls(), [])
})

test('rejects a preview that inserts a change for an unselected day', async t => {
    const response = { ...visible, changes: [...visible.changes, { ...visible.changes[0], date: '2026-11-24' }] }
    const { call, stateDir } = await setup(t, { response, envelope: { ...envelope, review: { ...response, proof: 'test' } } })
    assert.match((await call('preview', { week: monday, intent })).error ?? '', /revisión.*solicitada/)
    assert.deepEqual(await readdir(stateDir), [])
})

test('checks receipt for the provided week and never replays an uncertain operation', async t => {
    const receipt = {
        requestId, outcome: 'NOT_OBSERVED', action: null, monday, draftRevision: null, publishedRevision: null,
    }
    const { call, calls } = await setup(t, { response: receipt })
    assert.deepEqual(await call('operation', { week: monday, requestId }), { data: receipt })
    assert.deepEqual((await calls()).map(call => call.args), [
        ['--profile=trusted-office', '--json', 'attendance', 'roster', 'week', 'operation', '--week=' + monday,
            '--request-id=' + requestId],
    ])
})

test('downloads only the requested published PDF revision into an owned private file', async t => {
    const { call, calls } = await setup(t, { response: pdfMetadata, pdf: pdfBytes })
    const result = await call('pdf', { week: monday, revision: 2, employeeIds: [17] })
    const { pdfPath, ...received } = result.data
    assert.deepEqual(received, pdfMetadata)
    assert.equal(await readFile(pdfPath, 'utf8'), pdfBytes)
    assert.equal((await lstat(pdfPath)).mode & 0o777, 0o600)
    assert.equal((await lstat(dirname(pdfPath))).mode & 0o777, 0o700)
    assert.deepEqual((await calls())[0].args.slice(5), [
        'pdf', '--week=' + monday, '--revision=2', '--output=' + pdfPath, '--employee-id=17',
    ])
})

test('discards an invalid PDF or a response for another revision', async t => {
    for (const variant of [
        { response: pdfMetadata, pdf: 'not a PDF file' },
        { response: { ...pdfMetadata, revision: 3 }, pdf: pdfBytes },
    ]) {
        const { call, stateDir } = await setup(t, variant)
        assert.match((await call('pdf', { week: monday, revision: 2 })).error ?? '', /PDF/)
        assert.deepEqual(await readdir(stateDir), [])
    }
})

test('reports a refused office scope without exposing CLI stderr', async t => {
    const { call } = await setup(t, { error: 'HTTP 403 confidential office detail' })
    const result = await call('get', { week: monday, employeeIds: [17] })
    assert.match(result.error ?? '', /403/)
    assert.doesNotMatch(result.error ?? '', /confidential/)
})
