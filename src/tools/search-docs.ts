import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface SearchResult {
    id: string
    title: string
    description: string
    aiSummary: string | null
    relevance: number
}

export function registerSearchDocs(server: McpServer, client: ZincAppClient) {
    server.tool(
        'search_docs',
        'Search ZincApp developer documentation by keyword. Returns matching documents ranked by relevance.',
        { query: z.string().describe('Search query'), limit: z.number().optional().describe('Max results (default 10)') },
        async ({ query, limit }) => {
            const results = await client.get<SearchResult[]>(
                `/docs/search?q=${encodeURIComponent(query)}&limit=${limit || 10}`
            )

            const text = results.length === 0
                ? 'No documents found matching your query.'
                : results.map(r =>
                    `## ${r.title}\n- ID: \`${r.id}\`\n- ${r.aiSummary || r.description}\n- Relevance: ${r.relevance.toFixed(2)}`
                ).join('\n\n')

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
