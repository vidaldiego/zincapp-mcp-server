import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface AuditFinding {
    dimension: string
    status: string
    current: string | null
    expected: string | null
    provingField: string
}

interface RemovalAudit {
    removalId: number
    label: string
    findings: AuditFinding[]
    hasGaps: boolean
}

export function registerGetRetiradaAudit(server: McpServer, client: ZincAppClient) {
    server.tool(
        'get_retirada_audit',
        'Audit ONE waste removal (retirada) across every dimension: transporter (+ its T01/T02 ' +
            'authorization), NT, declared vs weighed kg, residue (LER), R/D operation codes, gestor ' +
            'NIMA/authorization/address, and attached documents. Each check reports ok / missing / ' +
            'mismatch plus the field that proves it. Read-only, no AI. The token must hold RETIRADAS_AUDIT ' +
            'and list the companyId.',
        {
            companyId: z.number().describe('The company (tenant) id, e.g. 9'),
            removalId: z.number().describe('The removal id to audit'),
        },
        async ({ companyId, removalId }) => {
            const a = await client.get<RemovalAudit>(
                `/mwm/retirada/audit/${removalId}`,
                { companyId: String(companyId) }
            )

            const icon = (s: string) => (s === 'ok' ? '✅' : s === 'mismatch' ? '⚠️' : '❌')
            const lines = a.findings.map(f => {
                const cur = f.current ?? '—'
                const exp = f.expected != null ? ` → esperado: ${f.expected}` : ''
                return `${icon(f.status)} **${f.dimension}**: ${f.status} (actual: ${cur}${exp}) · _${f.provingField}_`
            }).join('\n')

            const text =
                `# Retirada ${a.removalId} — ${a.label}\n` +
                `${a.hasGaps ? '**Tiene gaps.**' : '**Completa.**'}\n\n${lines}`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
