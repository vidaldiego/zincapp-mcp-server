import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OfficePresencia } from '../../dist/tools/presencia-office.js'
import { registerOfficePresencia } from '../../dist/tools/presencia.js'

const [from, until, employeeArgument, expected = 'export', waitArgument = '8'] = process.argv.slice(2)
const executable = process.env.ZINCAPP_ROSTER_CLI ?? ''
const profile = process.env.ZINCAPP_ROSTER_PROFILE ?? ''
assert(isAbsolute(executable) && profile.startsWith('b5-'), 'Use the isolated synthetic B5 CLI profile.')

if (from === '--server') {
    const server = new McpServer({ name: 'b5-office-synthetic-lab', version: '1.0.0' })
    registerOfficePresencia(server, new OfficePresencia({ executable, profile, stateDir: until }))
    await server.connect(new StdioServerTransport())
} else {
    await acceptance()
}

async function acceptance() {
    const employeeId = Number(employeeArgument)
    const waitSeconds = Number(waitArgument)
    for (const date of [from, until]) assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
    assert(Number.isSafeInteger(employeeId) && employeeId > 0)
    assert(Number.isSafeInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 120)
    assert(expected === 'export' || expected === 'read-only')
    const stateDir = await mkdtemp(join(tmpdir(), 'zincapp-b5-synthetic-lab-'))
    const client = new Client({ name: 'b5-lab-without-elicitation', version: '1.0.0' })
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
    delete env.ZINCAPP_AGENT_TOKEN
    const filter = { from, until, employeeIds: [employeeId] }
    const requestId = randomUUID()

    async function tool(name, args, denied = false) {
        const reply = await client.callTool({ name: 'attendance_presencia_' + name, arguments: args })
        if (denied) {
            assert(reply.isError)
            assert.match(reply.content[0].text, /HTTP 403/)
            return
        }
        assert(!reply.isError, `MCP tool ${name} failed`)
        return JSON.parse(reply.content[0].text)
    }

    function terminal(mode, proposalPath) {
        const result = spawnSync('python3', ['-c', pythonTerminal(), mode, proposalPath, executable, `--profile=${profile}`,
            'attendance', 'presencia', 'report', 'export', `--proposal=${proposalPath}`],
        { env, timeout: 35_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        assert.equal(result.status, 0, `CLI ${mode} failed (${result.stdout?.trim() || 'terminal check failed'})`)
    }

    try {
        await client.connect(new StdioClientTransport({
            command: process.execPath, args: [fileURLToPath(import.meta.url), '--server', stateDir], env,
        }))
        const tools = (await client.listTools()).tools.map(tool => tool.name)
        assert(!tools.some(name => /attendance_presencia_export_(apply|submit|confirm)/.test(name)))
        const summary = await tool('report_summary', filter)
        assert.equal(summary.from, from)
        assert.equal(summary.until, until)
        assert.equal(summary.canExport, expected === 'export')
        assert.deepEqual(summary.rows.map(row => row.employeeId), [employeeId])
        if (expected === 'read-only') {
            await tool('export_preview', { requestId, filter }, true)
            console.log('PASS synthetic office summary with export permission denied')
            return
        }

        const proposal = await tool('export_preview', { requestId, filter })
        assert.equal(proposal.review.requestId, requestId)
        assert.deepEqual(proposal.review.filter.employeeIds, filter.employeeIds)
        assert(!('proof' in proposal.review))
        assert.match(proposal.terminalCommand, /attendance presencia report export --proposal=/)
        assert(proposal.proposalPath.startsWith(stateDir + '/'))
        assert.equal((await lstat(proposal.proposalPath)).mode & 0o777, 0o600)
        const original = await readFile(proposal.proposalPath, 'utf8')
        const saved = JSON.parse(original)
        assert.match(saved.identity.apiBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/?$/, 'Require an isolated loopback profile before applying')
        assert.equal(saved.review.digest, proposal.review.digest)
        assert(saved.review.proof)

        terminal('cancel', proposal.proposalPath)
        assert.equal((await tool('export_operation', { requestId })).status, 'NOT_OBSERVED')
        saved.review.digest = saved.review.digest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64)
        await writeFile(proposal.proposalPath, JSON.stringify(saved))
        terminal('altered', proposal.proposalPath)
        assert.equal((await tool('export_operation', { requestId })).status, 'NOT_OBSERVED')
        await writeFile(proposal.proposalPath, original)
        terminal('confirm', proposal.proposalPath)

        // One finite wait for the laboratory worker, then one explicit status read.
        await setTimeout(waitSeconds * 1_000)
        const receipt = await tool('export_operation', { requestId })
        assert.equal(receipt.status, 'READY')
        assert.equal(receipt.from, from)
        assert.equal(receipt.until, until)
        const xlsx = await tool('export_xlsx', { requestId })
        assert.equal(xlsx.filename, `presencia-${from}_${until}.xlsx`)
        assert(xlsx.xlsxPath.startsWith(stateDir + '/'))
        assert.equal((await lstat(xlsx.xlsxPath)).mode & 0o777, 0o600)
        assert.equal((await lstat(xlsx.xlsxPath)).size, xlsx.bytes)
        const archive = spawnSync('unzip', ['-t', xlsx.xlsxPath], { stdio: 'ignore', timeout: 15_000 })
        assert.equal(archive.status, 0, 'Invalid synthetic workbook archive')
        console.log('PASS MCP stdio + real CLI: scoped summary, private handoff, cancellation, changed digest, explicit receipt and XLSX')
    } finally {
        await client.close().catch(() => {})
        await rm(stateDir, { recursive: true })
    }
}

function pythonTerminal() {
    return String.raw`import errno, json, os, pty, re, select, subprocess, sys, time
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
    while time.monotonic() < deadline:
        if not select.select([master], [], [], .2)[0]:
            if child.poll() is not None:
                break
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
    cancelled = b"cancelled" in transcript.splitlines()
    http = re.search(rb"\bHTTP ([45][0-9]{2})\b", transcript)
    passed = {
        "confirm": status == 0 and entered and not cancelled,
        "cancel": status == 0 and entered and cancelled,
        "altered": status != 0 and not entered,
    }[mode]
    if not passed:
        print(json.dumps({"exit": status, "prompt": entered, "cancelled": cancelled, "http": int(http[1]) if http else None}))
    sys.exit(0 if passed else 1)
finally:
    os.close(master)
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=2)`
}
