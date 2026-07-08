import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

interface CreateEntitySpec {
    cif: string
    nombre: string
    nima: number | null
    direccion: string | null
}

interface FieldChange {
    field: string
    label: string
    currentValue: string | null
    currentDisplay: string | null
    proposedValue: string | null
    proposedDisplay: string | null
    resolvable: boolean
    createEntity: CreateEntitySpec | null
}

interface RemovalDiff {
    removalId: number
    label: string
    docCount: number
    changes: FieldChange[]
    warnings: string[]
}

export function registerProposeCompletion(server: McpServer, client: ZincAppClient) {
    server.tool(
        'propose_completion',
        'Propose field completions for ONE waste removal by re-reading its attached documents (DIs, ' +
            'certificates) through the importer pipeline and diffing against the current DB values. Returns ' +
            'a typed diff: per field, the current value vs. the value read from the document, whether it ' +
            'resolves to a DB entity, and (for a carrier not yet in the DB) the data to create it. ' +
            'READ-ONLY — proposes only, never writes. One removal per call (cost control: scanned/CDO docs ' +
            'each cost an AI call). Requires RETIRADAS_AUDIT scope + the companyId in the allowlist.',
        {
            companyId: z.number().describe('The company (tenant) id, e.g. 9'),
            removalId: z.number().describe('The removal id to propose completions for'),
        },
        async ({ companyId, removalId }) => {
            const d = await client.get<RemovalDiff>(
                `/mwm/retirada/propose/${removalId}`,
                { companyId: String(companyId) }
            )

            if (d.changes.length === 0 && d.warnings.length === 0) {
                return { content: [{ type: 'text' as const, text: `# Retirada ${d.removalId} — ${d.label}\n\nSin cambios propuestos (${d.docCount} doc.).` }] }
            }

            const changeLines = d.changes.map(c => {
                const cur = c.currentDisplay ?? c.currentValue ?? '—'
                const prop = c.proposedDisplay ?? c.proposedValue ?? '—'
                const create = c.createEntity
                    ? ` · **CREAR entidad** ${c.createEntity.nombre} (CIF ${c.createEntity.cif}${c.createEntity.nima ? `, NIMA ${c.createEntity.nima}` : ''})`
                    : ''
                const unresolved = c.resolvable || c.createEntity ? '' : ' _(no resuelve a entidad)_'
                return `- **${c.label}** (\`${c.field}\`): ${cur} → **${prop}**${create}${unresolved}`
            }).join('\n')

            const warnLines = d.warnings.length
                ? '\n\n### Avisos\n' + d.warnings.map(w => `- ⚠️ ${w}`).join('\n')
                : ''

            const text =
                `# Retirada ${d.removalId} — ${d.label}\n` +
                `${d.docCount} documento(s) · ${d.changes.length} cambio(s) propuesto(s)\n\n` +
                changeLines + warnLines +
                `\n\n_Propuesta read-only. Aplicar requerirá confirmación humana (fase de escritura)._`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
