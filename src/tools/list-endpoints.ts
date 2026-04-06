import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface EndpointEntry {
    method: string
    path: string
    summary: string
    auth: string
    category: string
}

export function registerListEndpoints(server: McpServer, client: ZincAppClient) {
    server.tool(
        'list_api_endpoints',
        'List all ZincApp API endpoints available to your integration. Groups by category.',
        {},
        async () => {
            const endpoints = await client.get<EndpointEntry[]>('/reference/endpoints')

            if (endpoints.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No API endpoints available. You may need an accepted contract.' }] }
            }

            // Group by category
            const grouped = new Map<string, EndpointEntry[]>()
            for (const ep of endpoints) {
                const cat = ep.category || 'General'
                if (!grouped.has(cat)) grouped.set(cat, [])
                grouped.get(cat)!.push(ep)
            }

            let text = ''
            for (const [category, eps] of grouped) {
                text += `## ${category}\n\n`
                for (const ep of eps) {
                    text += `- \`${ep.method} ${ep.path}\` — ${ep.summary} (auth: ${ep.auth})\n`
                }
                text += '\n'
            }

            return { content: [{ type: 'text' as const, text: text.trim() }] }
        }
    )
}
