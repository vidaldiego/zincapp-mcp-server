import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { lookupNimaAuthorizations } from '../madrid-nima.js'

export function registerLookupAuthorization(server: McpServer, _client: ZincAppClient) {
    server.tool(
        'lookup_authorization',
        'Look up an entity\'s waste authorizations in the OFFICIAL Comunidad de Madrid NIMA registry ' +
            '(gestiona.comunidad.madrid) by NIF — the authoritative source for the registry NUMBER that ' +
            'the agent must never invent. Returns the entity with its centers (one per NIMA) and each ' +
            'center\'s authorizations, mapped to the system\'s authId codes (T01/G01/…). IMPORTANT: in ' +
            'the CM registry a company has DIFFERENT NIMAs per role — the transport authorization (T01/T02) ' +
            'lives on a different NIMA/center than the gestor authorization (G0x) — so this reveals which ' +
            'NIMA holds which. Read-only, proposes only: pass a found number to apply_authorization to write ' +
            'it. If a `nima` is given, only that center is returned.',
        {
            nif: z.string().describe('The entity NIF/CIF, e.g. "B86208824" (from audit_entities / propose_authorizations)'),
            nima: z.number().optional().describe('Restrict to the center with this exact NIMA (else all centers are returned)'),
        },
        async ({ nif, nima }) => {
            let result
            try {
                result = await lookupNimaAuthorizations({ nif, nima })
            } catch (e: any) {
                return { content: [{ type: 'text' as const, text: `No se pudo consultar el registro NIMA: ${e?.message ?? e}` }] }
            }

            const e = result.entidad
            if (e.centros.length === 0) {
                return { content: [{ type: 'text' as const, text: `Sin centros en el registro NIMA para NIF ${e.cif}.` }] }
            }

            const blocks = e.centros.map(c => {
                const auths = c.autorizaciones.length
                    ? c.autorizaciones.map(a =>
                        `  - \`${a.authId}\` · ${a.autorizacion} · ${a.estado ? 'ACTIVA' : 'baja'}`).join('\n')
                    : '  _(sin autorizaciones)_'
                return `### NIMA ${c.nima}\n${c.direccion}\n${auths}`
            }).join('\n\n')

            const text =
                `# Registro NIMA (Comunidad de Madrid) · ${e.nombre ?? e.cif}\n` +
                `NIF ${e.cif} · ${e.centros.length} centro(s)\n\n` +
                blocks +
                `\n\n_Fuente oficial. Para escribir un número: apply_authorization con el authId y el número ACTIVO correcto._`

            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
