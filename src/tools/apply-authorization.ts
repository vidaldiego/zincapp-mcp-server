import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

// One authorization to upsert on an entity center. authId = static TYPE (T01/T02/G0x from the
// catalogue); autorizacion = the official registry NUMBER the human supplies (the agent never invents it).
const AuthSchema = z.object({
    clientId: z.number().describe('The entity (client) id — from audit_entities / propose_authorizations'),
    centerId: z.number().describe('The entity center id'),
    authId: z.string().describe('The static authorization TYPE code, e.g. "T01" (hazardous transport), "G01" (gestor)'),
    autorizacion: z.string().describe('The official registry NUMBER for this authorization — YOU (the human) provide it; the agent never invents it'),
})

interface ApplyAuthResult {
    applied: number
    failed: { clientId: number; centerId: number; authId: string; error: string }[]
}

export function registerApplyAuthorization(server: McpServer, client: ZincAppClient) {
    server.tool(
        'apply_authorization',
        'Write (upsert) entity-center authorizations — the master-data WRITE complement to ' +
            'propose_authorizations. propose_authorizations tells you WHICH authorization TYPE a ' +
            'transporter/gestor is missing (e.g. T01); this writes it, WITH the official registry number ' +
            'THE HUMAN SUPPLIES in each item\'s `autorizacion`. The agent must NEVER invent that number — ' +
            'it is administrative master data (the company\'s inscription code in the waste registry), not ' +
            'something in the DIs. Each item: {clientId, centerId, authId (the type), autorizacion (the ' +
            'number)}. Upsert: updates the number if the authorization already exists, else creates it. ' +
            'Runs UNDER YOUR ACTIVE OPERATOR ELEVATION (company derived from it, no companyId); writes ' +
            'through the framework (hooks + audit) as the elevated _sysadmin, recording you in the audit ' +
            'trail. Only apply numbers you (the human) have verified.',
        {
            authorizations: z.array(AuthSchema)
                .describe('The authorizations to write, each with the registry number you provide'),
        },
        async ({ authorizations }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev
            const companyId = elev.companyId

            const result = await client.post<ApplyAuthResult>(
                '/mwm/retirada/apply-authorization',
                { confirm: true, authorizations }
            )

            const ok = result.applied
            const bad = result.failed.length
            const failLines = bad
                ? '\n\n### Fallidas\n' + result.failed.map(f =>
                    `- entidad ${f.clientId}/${f.centerId} · ${f.authId}: ${f.error}`).join('\n')
                : ''
            const text =
                `# Autorizaciones aplicadas · company ${companyId}\n` +
                `${ok} autorización(es) escrita(s)${bad ? `, ${bad} con error` : ''}, bajo tu elevación de operador.` +
                failLines +
                `\n\n_Recuerda des-elevarte desde el portal web con un motivo cuando termines._`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
