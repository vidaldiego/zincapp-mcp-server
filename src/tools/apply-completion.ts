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

interface BeginResponse {
    applyToken: string
    expiresAt: string
}

interface ApplyResult {
    applied: number[]
    failed: { removalId: number; error: string }[]
}

export function registerApplyCompletion(server: McpServer, client: ZincAppClient) {
    server.tool(
        'apply_completion',
        'Apply confirmed field completions to waste removals, ATTRIBUTED TO A REAL HUMAN. The operator ' +
            'must supply a fresh Google id-token (googleIdToken) — the write is recorded in the audit log ' +
            'under that person, never a system user. Two internal steps: begin-session verifies Google + ' +
            'the operator\'s write permission and mints a short-lived, single-use, batch-bound token; apply ' +
            'then writes each edit through the framework (hooks + audit fire). Requires the RETIRADAS_WRITE ' +
            'scope + companyId in the allowlist. Only apply edits the human has explicitly confirmed.',
        {
            companyId: z.number().describe('The company (tenant) id, e.g. 9'),
            googleIdToken: z.string().describe('A fresh Google id-token identifying the operator authorizing the write'),
            edits: z.array(EditSchema).describe('The confirmed edits (from propose_completion), one per removal'),
        },
        async ({ companyId, googleIdToken, edits }) => {
            // Step 1: exchange the Google id-token for a short-lived apply token bound to THIS batch.
            const begin = await client.post<BeginResponse>('/mwm/retirada/session/begin', {
                companyId,
                googleIdToken,
                edits,
            })

            // Step 2: apply the batch, carrying the token. The backend re-verifies the binding + human.
            const result = await client.post<ApplyResult>(
                '/mwm/retirada/apply',
                { companyId, confirm: true, edits },
                { 'X-Agent-Apply-Token': begin.applyToken }
            )

            const ok = result.applied.length
            const bad = result.failed.length
            const failLines = bad
                ? '\n\n### Fallidos\n' + result.failed.map(f => `- Retirada ${f.removalId}: ${f.error}`).join('\n')
                : ''
            const text =
                `# Aplicado · company ${companyId}\n` +
                `${ok} retirada(s) actualizada(s)${bad ? `, ${bad} con error` : ''}, atribuidas al operator.\n` +
                (ok ? '\nAplicadas: ' + result.applied.join(', ') : '') +
                failLines

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
