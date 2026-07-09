import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

interface AuthCandidate {
    authId: string
    name: string | null
    descripcion: string | null
    origen: boolean
    operador: boolean
    destino: boolean
    peligrosos: boolean
    noPeligrosos: boolean
    transportista: boolean
}

interface AuthProposal {
    role: string
    cif: string | null
    nombre: string | null
    clientId: number | null
    centerId: number | null
    usedByRemovals: number
    peligroso: boolean
    candidates: AuthCandidate[]
    warnings: string[]
}

interface AuthProposalResult {
    role: string
    proposals: AuthProposal[]
}

export function registerProposeAuthorizations(server: McpServer, client: ZincAppClient) {
    server.tool(
        'propose_authorizations',
        'PROPOSE-ONLY: for each gestor or transportista used by the company\'s removals that lacks the ' +
            'required authorization, suggest the static authorization TYPE codes (authId) that would ' +
            'satisfy it — T01/T02 by hazard for transporters, destino+hazard role flags for gestores. ' +
            'Read-only, never writes. A human still creates the authorization and supplies the real ' +
            'registry number; the agent only proposes the type. Runs under YOUR active operator elevation ' +
            '— the company is the one you elevated into from the web (no companyId parameter).',
        {
            role: z.enum(['gestor', 'transportista']).describe('Which party role to propose for'),
            year: z.number().optional().describe('Restrict to removals of this year (optional)'),
        },
        async ({ role, year }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev
            const companyId = elev.companyId

            const params: Record<string, string> = { role }
            if (year != null) params.year = String(year)
            const r = await client.get<AuthProposalResult>('/mwm/retirada/propose-authorizations', params)

            if (r.proposals.length === 0) {
                return { content: [{ type: 'text' as const, text: `Ningún ${r.role} sin autorización en la company ${companyId}.` }] }
            }

            const blocks = r.proposals.map(p => {
                const name = p.nombre ?? p.cif ?? '(sin nombre)'
                const coords = (p.clientId != null && p.centerId != null)
                    ? `  · entidad **${p.clientId}/${p.centerId}** (para apply_authorization)`
                    : '  · _(sin centro resoluble — no aplicable directamente)_'
                const cands = p.candidates.length
                    ? p.candidates.map(c => `  - \`${c.authId}\`${c.name ? ` — ${c.name}` : ''}`).join('\n')
                    : '  _(sin candidatos en el catálogo)_'
                const warns = p.warnings.map(w => `  ⚠️ ${w}`).join('\n')
                return `### ${name} — ${p.usedByRemovals} retirada(s)${p.peligroso ? ' · peligroso' : ''}${coords}\nCandidatos (authId):\n${cands}\n${warns}`
            }).join('\n\n')

            const text = `# Propuesta de autorizaciones · ${r.role}s · company ${companyId}\n${r.proposals.length} sin autorización\n\n${blocks}`
            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
