import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

interface EntityAudit {
    role: string
    cif: string | null
    nombre: string | null
    usedByRemovals: number
    nima: number | null
    nimaValid: boolean
    direccion: string | null
    direccionPlausible: boolean
    autorizacion: string | null
    autorizacionPresent: boolean
    peligroso: boolean
    hasGaps: boolean
}

interface EntityAuditResult {
    role: string
    parties: EntityAudit[]
}

export function registerAuditEntities(server: McpServer, client: ZincAppClient) {
    server.tool(
        'audit_entities',
        'Audit the gestores or transportistas used by a company\'s waste removals. For each distinct ' +
            'party it checks: authorization (T01/T02 by hazard for transporters; destino+hazard role ' +
            'flags for gestores), NIMA validity (exactly 10 digits), and address plausibility. Returns ' +
            'one row per party, ranked by how many removals use it. Read-only, no AI. Runs under YOUR ' +
            'active operator elevation — the company is the one you elevated into from the web (no ' +
            'companyId parameter).',
        {
            role: z.enum(['gestor', 'transportista']).describe('Which party role to audit'),
            year: z.number().optional().describe('Restrict to removals of this year (optional)'),
        },
        async ({ role, year }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev
            const companyId = elev.companyId

            const params: Record<string, string> = { role }
            if (year != null) params.year = String(year)
            const r = await client.get<EntityAuditResult>('/mwm/retirada/audit-entities', params)

            if (r.parties.length === 0) {
                return { content: [{ type: 'text' as const, text: `Sin ${r.role}s en las retiradas de la company ${companyId}.` }] }
            }

            const rows = r.parties.map(p => {
                const flag = (ok: boolean) => (ok ? '✅' : '❌')
                const name = p.nombre ?? p.cif ?? '(sin nombre)'
                const checks =
                    `NIMA ${flag(p.nimaValid)}${p.nima ? ` (${p.nima})` : ''} · ` +
                    `Dir ${flag(p.direccionPlausible)} · ` +
                    `Autoriz ${flag(p.autorizacionPresent)}${p.autorizacion ? ` (${p.autorizacion})` : ''}`
                const gap = p.hasGaps ? '⚠️ ' : ''
                return `- ${gap}**${name}** — ${p.usedByRemovals} retirada(s)${p.peligroso ? ' · peligroso' : ''}\n  ${checks}`
            }).join('\n')

            const gapCount = r.parties.filter(p => p.hasGaps).length
            const text =
                `# Auditoría ${r.role}s · company ${companyId}\n` +
                `${r.parties.length} ${r.role}(s), ${gapCount} con gaps\n\n${rows}`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
