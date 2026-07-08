import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface AuditStats {
    year: number
    total: number
    abiertas: number
    sinNt: number
    sinDi: number
    sinTransportista: number
    kgMismatch: number
    ntExcesoKg: number
    sinResiduo: number
}

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

interface AuditResponse {
    stats: AuditStats
    worst: RemovalAudit[]
    ranked: number
    scanned: number
}

export function registerAuditRetiradas(server: McpServer, client: ZincAppClient) {
    server.tool(
        'audit_retiradas',
        'Audit a company\'s waste removals (retiradas) for a year. Returns a health projection — how ' +
            'many removals are missing an NT, a transporter, documents, a residue, how many have a kg ' +
            'mismatch or exceed NT capacity — plus a ranked list of the worst offenders. Read-only, no AI. ' +
            'The token must hold the RETIRADAS_AUDIT scope and list the companyId in its allowlist.',
        {
            companyId: z.number().describe('The company (tenant) id to audit, e.g. 9 for La Paz'),
            year: z.number().describe('Calendar year, e.g. 2025'),
            limit: z.number().optional().describe('Max ranked removals to return (default 20, max 100)'),
        },
        async ({ companyId, year, limit }) => {
            const params: Record<string, string> = { companyId: String(companyId), year: String(year) }
            if (limit != null) params.limit = String(limit)
            const r = await client.get<AuditResponse>('/mwm/retirada/audit', params)

            const s = r.stats
            const summary =
                `# Auditoría retiradas · company ${companyId} · ${s.year}\n\n` +
                `**Total:** ${s.total} (${s.abiertas} abiertas)\n\n` +
                `| Dimensión | Faltan |\n|---|---|\n` +
                `| Sin NT | ${s.sinNt} |\n` +
                `| Sin transportista | ${s.sinTransportista} |\n` +
                `| Sin documentos | ${s.sinDi} |\n` +
                `| Sin residuo (LER) | ${s.sinResiduo} |\n` +
                `| Kg mismatch | ${s.kgMismatch} |\n` +
                `| Exceso capacidad NT | ${s.ntExcesoKg} |\n`

            const ranked = r.worst.length === 0
                ? '\n\n_Sin retiradas con gaps en el ranking escaneado._'
                : '\n\n## Peores retiradas (por nº de gaps)\n' +
                    r.worst.map(w => {
                        const gaps = w.findings.filter(f => f.status !== 'ok')
                            .map(f => `${f.dimension}:${f.status}`).join(', ')
                        return `- **${w.removalId}** (${w.label}) — ${gaps}`
                    }).join('\n')

            const note = `\n\n_Escaneadas ${r.scanned} retiradas para el ranking (top ${r.ranked})._`

            return { content: [{ type: 'text' as const, text: summary + ranked + note }] }
        }
    )
}
