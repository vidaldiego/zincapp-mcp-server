#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { ZincAppClient } from './client.js'
import { registerAllTools } from './tools/index.js'
import { registerAllResources } from './resources/index.js'

async function main() {
    const config = loadConfig()
    const client = new ZincAppClient(config)

    const server = new McpServer({
        name: 'zincapp',
        version: '1.0.0',
    })

    registerAllTools(server, client)
    registerAllResources(server, client)

    const transport = new StdioServerTransport()
    await server.connect(transport)
}

main().catch((err) => {
    console.error('Failed to start ZincApp MCP server:', err.message || err)
    process.exit(1)
})
