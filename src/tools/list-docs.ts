import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface DocSummary {
    id: string
    title: string
    description: string
    aiSummary: string | null
}

export function registerListDocs(server: McpServer, client: ZincAppClient) {
    server.tool(
        'list_docs',
        'List all available ZincApp developer documentation with titles and summaries.',
        { locale: z.enum(['en', 'es']).optional().describe('Language locale (default: config locale)') },
        async ({ locale }) => {
            const params = locale ? { locale } : undefined
            const docs = await client.get<DocSummary[]>('/docs?limit=200', params)

            const text = docs.length === 0
                ? 'No documentation available.'
                : docs.map(d =>
                    `- **${d.title}** (\`${d.id}\`): ${d.aiSummary || d.description}`
                ).join('\n')

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
