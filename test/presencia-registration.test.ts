import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('office stdio exposes Presencia reads and proposals alongside the existing roster', async t => {
    const client = new Client({ name: 'office-test', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
        env: { ZINCAPP_ROSTER_CLI: '/unused/zincapi', ZINCAPP_ROSTER_PROFILE: 'office', ZINCAPP_AGENT_TOKEN: '' },
    }))

    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    assert.deepEqual(names.filter(name => name.startsWith('attendance_presencia_')).sort(), [
        'attendance_presencia_assist_preview',
        'attendance_presencia_configuration_get',
        'attendance_presencia_configuration_preview',
        'attendance_presencia_correction_preview',
        'attendance_presencia_days_get',
        'attendance_presencia_days_list',
        'attendance_presencia_operation',
        'attendance_presencia_requests_list',
        'attendance_presencia_resolution_preview',
    ])
    assert.ok(names.includes('attendance_roster_publish'))
})
