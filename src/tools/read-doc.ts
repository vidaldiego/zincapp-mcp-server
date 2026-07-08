import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface DocDetail {
    id: string
    title: string
    markdown: string
    aiSummary: string | null
}

export function registerReadDoc(server: McpServer, client: ZincAppClient) {
    server.tool(
        'read_doc',
        'Read a specific ZincApp documentation page by its ID. Returns the full markdown content.',
        {
            docId: z.string().describe('Document ID (e.g. "api.overview")'),
            locale: z.enum(['en', 'es']).optional().describe('Language locale (default: config locale)'),
        },
        async ({ docId, locale }) => {
            const params = locale ? { locale } : undefined
            const doc = await client.get<DocDetail>(`/docs/${encodeURIComponent(docId)}`, params)

            const text = `# ${doc.title}\n\n${doc.markdown}`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
