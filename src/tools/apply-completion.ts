import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'

// The confirmed edit shape (mirrors the backend ReconcileApplyItem). Produced from propose_completion.
const EditSchema = z.object({
    removalId: z.number(),
    fields: z.record(z.string(), z.string().nullable()).optional(),
    createTransport: z
        .object({
            cif: z.string(),
            nombre: z.string(),
            nima: z.number().nullable().optional(),
            direccion: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    ntId: z.number().nullable().optional(),
})

interface CurrentElevation {
    companyId: number | null
    elevated: boolean
}

interface ApplyResult {
    applied: number[]
    failed: { removalId: number; error: string }[]
}

export function registerApplyCompletion(server: McpServer, client: ZincAppClient) {
    server.tool(
        'apply_completion',
        'Apply confirmed field completions to waste removals, UNDER YOUR ACTIVE OPERATOR ELEVATION. ' +
            'You (the platform operator) must first elevate into the company from the web (IAM) — this ' +
            'tool NEVER opens an elevation itself (that requires the web step-up). It checks your current ' +
            'elevation, and if you are not elevated into this company it asks you to do so in the web, then ' +
            'applies each confirmed edit through the framework (hooks + audit fire) as the elevated ' +
            '_sysadmin, recording the real operator in the elevation audit trail. Requires the ' +
            'RETIRADAS_WRITE scope + companyId in the token allowlist. Only apply edits you have confirmed.',
        {
            companyId: z.number().describe('The company (tenant) id you are elevated into, e.g. 9'),
            edits: z.array(EditSchema).describe('The confirmed edits (from propose_completion), one per removal'),
        },
        async ({ companyId, edits }) => {
            // Step 1: check the operator's current elevation (opened in the web with step-up).
            const elev = await client.get<CurrentElevation>('/mwm/retirada/operator/current-elevation')
            if (!elev.elevated) {
                return { content: [{ type: 'text' as const, text:
                    `No estás elevado a ningún tenant. Elévate a la company ${companyId} desde el portal web ` +
                    `(IAM → elevar), y luego vuelve a lanzar apply_completion.` }] }
            }
            if (elev.companyId !== companyId) {
                return { content: [{ type: 'text' as const, text:
                    `Estás elevado a la company ${elev.companyId}, no a la ${companyId}. Des-elévate y eleva a ` +
                    `la ${companyId} desde el portal web, luego vuelve a lanzar apply_completion.` }] }
            }

            // Step 2: apply under the active elevation. The backend re-verifies eligibility + the live OPEN.
            const result = await client.post<ApplyResult>(
                '/mwm/retirada/apply-elevated',
                { companyId, confirm: true, edits }
            )

            const ok = result.applied.length
            const bad = result.failed.length
            const failLines = bad
                ? '\n\n### Fallidos\n' + result.failed.map(f => `- Retirada ${f.removalId}: ${f.error}`).join('\n')
                : ''
            const text =
                `# Aplicado · company ${companyId}\n` +
                `${ok} retirada(s) actualizada(s)${bad ? `, ${bad} con error` : ''}, bajo tu elevación de operador.\n` +
                (ok ? '\nAplicadas: ' + result.applied.join(', ') : '') +
                failLines +
                `\n\n_Recuerda des-elevarte desde el portal web con un motivo cuando termines._`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
