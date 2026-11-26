import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OfficeRosterWeek } from '../../dist/tools/roster-week-office.js'
import { registerOfficeRosterWeek } from '../../dist/tools/roster-week.js'

const [week, employeeArgument] = process.argv.slice(2)
const executable = process.env.ZINCAPP_ROSTER_CLI ?? ''
const profile = process.env.ZINCAPP_ROSTER_PROFILE ?? ''
assert(isAbsolute(executable) && profile.startsWith('b4-'), 'Use the isolated synthetic B4 CLI profile.')

if (week === '--server') {
    const server = new McpServer({ name: 'b4-office-synthetic-lab', version: '1.0.0' })
    registerOfficeRosterWeek(server, new OfficeRosterWeek({ executable, profile, stateDir: employeeArgument }))
    await server.connect(new StdioServerTransport())
} else {
    await acceptance()
}

async function acceptance() {
    assert.match(week, /^\d{4}-\d{2}-\d{2}$/)
    const employeeId = Number(employeeArgument)
    assert(Number.isSafeInteger(employeeId) && employeeId > 0)
    const stateDir = await mkdtemp(join(tmpdir(), 'zincapp-b4-synthetic-lab-'))
    const client = new Client({ name: 'b4-lab-without-elicitation', version: '1.0.0' })
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
    delete env.ZINCAPP_AGENT_TOKEN
    const args = [`--profile=${profile}`, '--json', 'attendance', 'roster', 'week']
    function cli(verb, flags) {
        const result = spawnSync(executable, [...args, verb, ...flags], { encoding: 'utf8', env, timeout: 25_000 })
        assert.equal(result.status, 0, 'Direct synthetic CLI read failed')
        return JSON.parse(result.stdout)
    }
    function terminal(mode, prepared) {
        const verb = prepared.review.action === 'PUBLISH' ? 'publish' : 'save'
        const result = spawnSync('python3', ['-c', terminalRunner(), mode, prepared.proposalPath, executable,
            `--profile=${profile}`, 'attendance', 'roster', 'week', verb, `--proposal=${prepared.proposalPath}`],
        { env, timeout: 35_000, stdio: 'ignore' })
        assert.equal(result.status, 0, `Interactive CLI failed the synthetic ${mode} scenario`)
    }
    async function tool(name, args) {
        const response = await client.callTool({ name: 'attendance_roster_week_' + name, arguments: args })
        assert(!response.isError, `MCP tool ${name} failed`)
        return JSON.parse(response.content[0].text)
    }
    const scope = { week, employeeIds: [employeeId] }
    const lookup = () => tool('get', scope)
    const receipt = requestId => tool('operation', { week, requestId })
    function review(snapshot, action, cells) {
        return tool('preview', { week, intent: {
            requestId: randomUUID(), action, draftRevision: snapshot.draftRevision,
            publishedRevision: snapshot.publishedRevision ?? null, cells: cells.map(cell => ({ employeeId, ...cell })),
        } })
    }
    async function preview(snapshot, action, cells) {
        const prepared = await review(snapshot, action, cells)
        assert.deepEqual(prepared.review.blockers, [], 'Synthetic week must be eligible and unused')
        assert(prepared.proposalPath.startsWith(stateDir + '/'))
        assert(!('proof' in prepared.review))
        assert.equal((await lstat(prepared.proposalPath)).mode & 0o777, 0o600)
        const saved = JSON.parse(await readFile(prepared.proposalPath, 'utf8'))
        assert(saved.review.proof && saved.review.digest === prepared.review.digest)
        assert.match(saved.identity.apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/?$/, 'Require an isolated loopback profile before applying')
        assert.match(prepared.terminalCommand, /attendance roster week (save|publish) --proposal=/)
        return { prepared, saved }
    }
    try {
        await client.connect(new StdioClientTransport({
            command: process.execPath, args: [fileURLToPath(import.meta.url), '--server', stateDir], env,
        }))
        assert(!(await client.listTools()).tools.some(tool => /attendance_roster_week_(save|publish|apply)/.test(tool.name)))
        const original = await lookup()
        assert.deepEqual(original, cli('show', ['--week=' + week, '--employee-id=' + employeeId]))
        assert.equal(original.people.length, 1)
        assert.equal(original.publishedRevision ?? null, null, 'Choose a fresh week for the synthetic smoke')
        const shifts = await tool('shifts', scope)
        assert.deepEqual(shifts, original.shifts)
        assert.deepEqual(await tool('people', scope), original.people)
        assert(shifts.length > 0, 'Synthetic fixture needs an authorized shift')
        const dates = original.people[0].cells.map(cell => cell.date)
        const [monday, tuesday, wednesday, thursday, , saturday] = dates
        const at = (snapshot, date) => snapshot.people[0].cells.find(cell => cell.date === date)
        const shift = { choice: 'SHIFT', shiftId: shifts[0].id, section: 'MCP sintético', paidBreakMinutes: 5, unpaidBreakMinutes: 10 }
        const blocked = await review(original, 'PUBLISH', [{ date: monday, ...shift }])
        assert(blocked.review.blockers.some(blocker => blocker.code === 'PRESENCIA_ROSTER_PENDING_WEEKDAY' && blocker.date !== monday))
        assert.equal(blocked.proposalPath, undefined)
        const { prepared: first, saved } = await preview(original, 'PUBLISH', [
            ...dates.slice(0, 5).map(date => ({ date, ...shift })), { date: saturday, choice: 'PENDING' },
        ])

        terminal('cancel', first)
        assert.equal((await receipt(first.review.requestId)).outcome, 'NOT_OBSERVED')
        await writeFile(first.proposalPath, JSON.stringify({
            ...saved, review: { ...saved.review, digest: saved.review.digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) },
        }))
        terminal('altered', first)
        assert.equal((await receipt(first.review.requestId)).outcome, 'NOT_OBSERVED')
        await writeFile(first.proposalPath, JSON.stringify(saved))
        terminal('confirm', first)
        const firstReceipt = await receipt(first.review.requestId)
        assert.equal(firstReceipt.outcome, 'CONFIRMED')
        const published = await lookup()
        assert.equal(at(published, saturday).published.kind, 'PENDING')
        const pending = await tool('pending', scope)
        assert(pending[0].dates.includes(saturday))

        const { prepared: draft } = await preview(published, 'SAVE_DRAFT', [{ date: thursday, ...shift, section: 'MCP jueves' }])
        terminal('confirm', draft)
        assert.equal((await receipt(draft.review.requestId)).outcome, 'CONFIRMED')
        const withDraft = await lookup()
        assert.equal(at(withDraft, thursday).draft.section, 'MCP jueves')
        assert.equal(at(withDraft, thursday).draft.paidBreakMinutes, shift.paidBreakMinutes)
        assert.equal(at(withDraft, thursday).draft.unpaidBreakMinutes, shift.unpaidBreakMinutes)

        const { prepared: nonContiguous } = await preview(withDraft, 'PUBLISH', [
            { date: monday, choice: 'REST' }, { date: wednesday, choice: 'REST' },
        ])
        terminal('confirm', nonContiguous)
        const exact = await lookup()
        assert.equal(at(exact, monday).published.kind, 'REST')
        assert.equal(at(exact, wednesday).published.kind, 'REST')
        assert.deepEqual(at(exact, tuesday), at(withDraft, tuesday))
        assert.deepEqual(at(exact, thursday), at(withDraft, thursday))

        const pdf = await tool('pdf', { ...scope, revision: firstReceipt.publishedRevision })
        assert(pdf.pdfPath.startsWith(stateDir + '/'))
        assert.equal((await lstat(pdf.pdfPath)).mode & 0o777, 0o600)
        const bytes = await readFile(pdf.pdfPath)
        assert.equal(bytes.length, pdf.bytes)
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')

        const { prepared: saturdayOnly } = await preview(exact, 'PUBLISH', [{ date: saturday, ...shift }])
        terminal('confirm', saturdayOnly)
        assert.equal((await receipt(saturdayOnly.review.requestId)).publishedRevision, exact.publishedRevision + 1)
        const revised = await lookup()
        assert.equal(at(revised, saturday).published.kind, 'SHIFT')
        assert.deepEqual(at(revised, thursday), at(withDraft, thursday))
        assert.deepEqual(at(revised, wednesday), at(exact, wednesday))
        const archivedPdf = await tool('pdf', { ...scope, revision: firstReceipt.publishedRevision })
        assert.equal(archivedPdf.revision, firstReceipt.publishedRevision)
        console.log('PASS MCP stdio + real CLI: parity, private handoff, cancellation, altered digest, exact partial publication, independent Saturday and published PDF')
    } finally {
        await client.close().catch(() => {})
        await rm(stateDir, { recursive: true })
    }
}

function terminalRunner() {
    return String.raw`import errno, json, os, pty, select, subprocess, sys, time
mode, proposal, *command = sys.argv[1:]
with open(proposal) as file:
    digest = json.load(file)["review"]["digest"]
master, slave = pty.openpty()
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
transcript = b""
entered = False
try:
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline and child.poll() is None:
        if not select.select([master], [], [], 0.2)[0]:
            continue
        try:
            transcript += os.read(master, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not entered and b"to confirm: " in transcript:
            os.write(master, ((digest if mode == "confirm" else "cancel") + "\n").encode())
            entered = True
    status = child.wait(timeout=4)
    passed = (status == 0 and entered) if mode == "confirm" else (status != 0 and (entered == (mode == "cancel")))
    sys.exit(0 if passed else 1)
finally:
    os.close(master)
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=2)`
}
