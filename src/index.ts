#!/usr/bin/env node

import { dirname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { ZincAppClient } from './client.js'
import { registerAllTools } from './tools/index.js'
import { registerAllResources } from './resources/index.js'
import { registerOfficeRoster } from './tools/roster.js'
import { OfficeRoster } from './tools/roster-office.js'
import { OfficePresencia } from './tools/presencia-office.js'
import { registerOfficePresencia } from './tools/presencia.js'

async function main() {
    const config = loadConfig()

    const server = new McpServer({
        name: 'zincapp',
        version: '1.0.0',
    })

    if (config.agentToken) {
        const client = new ZincAppClient(config)
        registerAllTools(server, client)
        registerAllResources(server, client)
    }
    if (config.roster) {
        registerOfficeRoster(server, new OfficeRoster(config.roster))
        registerOfficePresencia(server, new OfficePresencia({
            ...config.roster,
            stateDir: join(dirname(config.roster.stateDir), 'office-presencia'),
        }))
    }

    const transport = new StdioServerTransport()
    await server.connect(transport)
}

main().catch((err) => {
    console.error('Failed to start ZincApp MCP server:', err.message || err)
    process.exit(1)
})
