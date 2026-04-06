import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface SandboxResponse {
    status: number
    body: string | null
    headers: Record<string, string> | null
}

export function registerSandboxRequest(server: McpServer, client: ZincAppClient) {
    server.tool(
        'sandbox_api_request',
        'Execute a test API call in the ZincApp sandbox environment. Only works with the SANDBOX_API scope.',
        {
            method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
            path: z.string().describe('API path to call (e.g. "/containers")'),
            body: z.string().optional().describe('Request body as JSON string (for POST/PUT)'),
        },
        async ({ method, path, body }) => {
            const result = await client.post<SandboxResponse>('/sandbox/relay', {
                method,
                path,
                body: body || null,
            })

            const text = [
                `**Status:** ${result.status}`,
                '',
                '```json',
                result.body || '(empty)',
                '```',
            ].join('\n')

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
