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
