import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface ContractDetail {
    contractId: number
    title: string
    description: string | null
    version: string
    status: string
    terms: string | null
    spec: string | null
    createdAt: string | null
}

export function registerGetContract(server: McpServer, client: ZincAppClient) {
    server.tool(
        'get_contract_spec',
        'Get details about a specific integration contract, including its API spec and terms.',
        { contractId: z.number().describe('Contract ID') },
        async ({ contractId }) => {
            const contract = await client.get<ContractDetail>(`/contracts/${contractId}`)

            const parts = [
                `# ${contract.title} (v${contract.version})`,
                '',
                `**Status:** ${contract.status}`,
            ]

            if (contract.description) {
                parts.push('', contract.description)
            }

            if (contract.terms) {
                parts.push('', '## Terms', '', contract.terms)
            }

            if (contract.spec) {
                parts.push('', '## API Spec', '', '```json', contract.spec, '```')
            }

            return { content: [{ type: 'text' as const, text: parts.join('\n') }] }
        }
    )
}
