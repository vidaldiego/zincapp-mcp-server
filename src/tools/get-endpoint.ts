import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface EndpointDetail {
    method: string
    path: string
    summary: string
    auth: string
    category: string
}

export function registerGetEndpoint(server: McpServer, client: ZincAppClient) {
    server.tool(
        'get_api_endpoint',
        'Get details about a specific API endpoint by method and path.',
        {
            method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
            path: z.string().describe('API path (e.g. "/containers")'),
        },
        async ({ method, path }) => {
            const encodedPath = path.startsWith('/') ? path.substring(1) : path
            const detail = await client.get<EndpointDetail>(
                `/reference/endpoints/${method}/${encodedPath}`
            )

            const text = [
                `## ${detail.method} ${detail.path}`,
                '',
                `**Summary:** ${detail.summary}`,
                `**Auth:** ${detail.auth}`,
                `**Category:** ${detail.category}`,
            ].join('\n')

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
