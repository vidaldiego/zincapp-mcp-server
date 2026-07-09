import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

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
            'elevation, and if you are not elevated it asks you to do so in the web, then applies each ' +
            'confirmed edit through the framework (hooks + audit fire) as the elevated _sysadmin, ' +
            'recording the real operator in the elevation audit trail. The company is DERIVED from your ' +
            'elevation (no companyId parameter). Only apply edits you have confirmed.',
        {
            edits: z.array(EditSchema).describe('The confirmed edits (from propose_completion), one per removal'),
        },
        async ({ edits }) => {
            // Step 1: check the operator's current elevation (opened in the web with step-up). The
            // company is whatever you elevated into — it is never passed by the tool.
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev
            const companyId = elev.companyId

            // Step 2: apply under the active elevation. The backend derives the company from the live
            // OPEN row and re-verifies eligibility — the companyId is NOT sent (server is the authority).
            const result = await client.post<ApplyResult>(
                '/mwm/retirada/apply-elevated',
                { confirm: true, edits }
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
