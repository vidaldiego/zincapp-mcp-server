import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface DocSummary {
    id: string
    title: string
    description: string
    aiSummary: string | null
}

export function registerAllResources(server: McpServer, client: ZincAppClient) {
    server.resource(
        'docs-index',
        'docs://index',
        async (uri) => {
            const docs = await client.get<DocSummary[]>('/docs?limit=200')

            const text = docs.length === 0
                ? 'No documentation available.'
                : [
                    '# ZincApp Documentation Index',
                    '',
                    ...docs.map(d => `- **${d.title}** (\`${d.id}\`): ${d.aiSummary || d.description}`),
                ].join('\n')

            return {
                contents: [{
                    uri: uri.href,
                    mimeType: 'text/markdown',
                    text,
                }],
            }
        }
    )
}
