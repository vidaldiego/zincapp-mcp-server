import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

interface NtParties {
    originId: number | null
    originCenterId: number | null
    operatorId: number | null
    operatorCenterId: number | null
    destId: number | null
    destCenterId: number | null
}

interface NtProposal {
    removalId: number
    alreadyHasNt: boolean
    linkExistingNtId: number | null
    reuseContractId: number | null
    parties: NtParties
    codigoLer: string | null
    residueId: number | null
    existingCtLerResidueId: number | null
    proposedCantidad: string | null
    transportId: number | null
    transportCenterId: number | null
    fecha: string | null
    warnings: string[]
}

export function registerProposeNt(server: McpServer, client: ZincAppClient) {
    server.tool(
        'propose_nt',
        'PROPOSE-ONLY: for a removal WITHOUT an NT (notificación previa), describe the contract + NT + ' +
            'NT-LER that would be created to cover it, with the create-vs-reuse dedup (existing contract ' +
            'by parties, existing NT by code) and the human-review warnings. Read-only, never writes — ' +
            'creating an NT is high-risk (wrong contract, duplicate, capacity), so a human confirms and ' +
            'creates via the web UI. Runs under YOUR active operator elevation — the company is the one ' +
            'you elevated into from the web (no companyId parameter).',
        {
            removalId: z.number().describe('The removal id (must have no NT)'),
        },
        async ({ removalId }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev
            const companyId = elev.companyId

            const p = await client.get<NtProposal>(`/mwm/retirada/propose-nt/${removalId}`)

            if (p.alreadyHasNt) {
                return { content: [{ type: 'text' as const, text: `La retirada ${removalId} ya tiene NT. Nada que proponer.` }] }
            }

            const contract = p.reuseContractId != null
                ? `Contrato: **reusar** el existente (ctId ${p.reuseContractId})`
                : `Contrato: **crear uno nuevo** (no existe para estas partes)`
            const parties =
                `Partes — origen: ${p.parties.originId}/${p.parties.originCenterId} · ` +
                `operador/destino: ${p.parties.destId}/${p.parties.destCenterId}`
            const residuo = `Residuo: LER ${p.codigoLer ?? '?'} (residueId ${p.residueId ?? '?'}` +
                `${p.existingCtLerResidueId != null ? `, reusar residueId ${p.existingCtLerResidueId} del CT_LER` : ''})`
            const cantidad = `Cantidad NT propuesta: ${p.proposedCantidad ?? '(desconocida)'}`
            const warns = p.warnings.map(w => `- ⚠️ ${w}`).join('\n')

            const text =
                `# Propuesta de NT · retirada ${p.removalId} · company ${companyId}\n\n` +
                `${contract}\n${parties}\n${residuo}\n${cantidad}\n\n### Avisos de revisión\n${warns}\n\n` +
                `_Propuesta read-only. La creación la confirma y ejecuta una persona (por el framework)._`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
