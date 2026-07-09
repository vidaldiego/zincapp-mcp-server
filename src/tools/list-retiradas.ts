import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

interface ListRow {
    removalId: number
    label: string
    hasNt: boolean
    otherGapCount: number
}

interface ListResponse {
    dimension: string
    status: string
    total: number
    scanned: number
    scanCapped: boolean
    offset: number
    items: ListRow[]
}

const DIMENSIONS = [
    'transportista', 'autorizacion-transportista', 'nt', 'kgDi', 'residuo',
    'rd-origen', 'rd-final', 'gestor-nima', 'autorizacion-gestor', 'direccion-gestor', 'documentos',
] as const

export function registerListRetiradas(server: McpServer, client: ZincAppClient) {
    server.tool(
        'list_retiradas',
        'Enumerate a year\'s waste removals that FAIL (or match) ONE audit dimension — the missing ' +
            'complement to audit_retiradas, which only ranks the worst removals by TOTAL gap count (so a ' +
            'removal whose only gap is e.g. a missing transportista never surfaces). Use this to walk the ' +
            'full population for a single dimension and triage it. Each row is light: removalId, label, ' +
            'hasNt (LOAD-BEARING — a missing transportista is inherited from the NT, so hasNt=false means ' +
            'the real fix is the NT, not the transportista), and otherGapCount (how many OTHER dimensions ' +
            'also fail, so you can pick the clean single-gap ones). Paginated. Read-only, no AI. Runs ' +
            'under your active operator elevation — the company is the one you elevated into (no companyId).',
        {
            year: z.number().describe('Calendar year, e.g. 2025'),
            dimension: z.enum(DIMENSIONS).describe('Which audit dimension to filter on'),
            status: z.enum(['missing', 'mismatch', 'ok']).optional()
                .describe('Which status to match for that dimension (default: missing)'),
            offset: z.number().optional().describe('Page offset into the matching set (default 0)'),
            limit: z.number().optional().describe('Page size (default 50, max 200)'),
        },
        async ({ year, dimension, status, offset, limit }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            const params: Record<string, string> = { year: String(year), dimension }
            if (status) params.status = status
            if (offset != null) params.offset = String(offset)
            if (limit != null) params.limit = String(limit)
            const r = await client.get<ListResponse>('/mwm/retirada/list', params)

            const st = r.status
            if (r.total === 0) {
                return { content: [{ type: 'text' as const, text:
                    `Ninguna retirada con ${r.dimension}:${st} en ${year} (escaneadas ${r.scanned}).` }] }
            }

            const shown = r.items.length
            const pageEnd = r.offset + shown
            const withNt = r.items.filter(i => i.hasNt).length
            const cleanest = r.items.filter(i => i.otherGapCount === 0).length

            const lines = r.items.map(i =>
                `- **${i.removalId}**  ${i.label}` +
                `  · NT: ${i.hasNt ? 'sí' : 'NO'}` +
                `  · otros gaps: ${i.otherGapCount}`
            ).join('\n')

            const capNote = r.scanCapped
                ? `\n\n⚠️ El escaneo llegó al límite (${r.scanned}); pueden existir más retiradas sin evaluar.`
                : ''
            const pageNote = r.total > pageEnd
                ? `\n\n_Mostrando ${r.offset + 1}–${pageEnd} de ${r.total}. Siguiente página: offset=${pageEnd}._`
                : `\n\n_Mostrando ${r.offset + 1}–${pageEnd} de ${r.total} (última página)._`

            const summary =
                `# Retiradas con ${r.dimension}:${st} · ${year}\n` +
                `**${r.total}** en total · en esta página: ${withNt} con NT, ${cleanest} sin otros gaps.\n\n` +
                lines + pageNote + capNote

            return { content: [{ type: 'text' as const, text: summary }] }
        }
    )
}
