import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

interface UpsertEntidadResult {
    clientId: number
    outcome: string
}

interface UpsertCentroResult {
    clientId: number
    centerId: number
    outcome: string
}

export function registerUpsertGestor(server: McpServer, client: ZincAppClient) {
    server.tool(
        'upsert_entidad',
        'Alta o completado (best-effort) de una entidad gestor/transportista por CIF, bajo la elevación del ' +
            'operador. Idempotente: si el CIF ya existe la completa (solo los campos aportados), si no la crea. ' +
            'No valida E3L: rellena lo disponible.',
        {
            cif: z.string().describe('CIF de la entidad (identidad; requerido).'),
            nombre: z.string().optional(),
            entityType: z.number().int().optional().describe('tipo_entidad (E3L lo exige a nivel entidad).'),
            telefono: z.string().optional(),
            mail: z.string().optional(),
            gestor: z.boolean().optional(),
            transportista: z.boolean().optional(),
        },
        async (args) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            const res = await client.post<UpsertEntidadResult>(
                '/mwm/retirada/upsert-entidad',
                { confirm: true, ...args }
            )

            const verbo = res.outcome === 'created' ? 'creada' : 'actualizada'
            return {
                content: [{
                    type: 'text' as const,
                    text: `Entidad **${verbo}** (CIF \`${args.cif}\`) — clientId \`${res.clientId}\`.`,
                }],
            }
        }
    )

    server.tool(
        'upsert_centro',
        'Alta o completado (best-effort) de un centro de un gestor, bajo la elevación del operador. Identidad ' +
            'por centerId o por nima inequívoco (varios con la misma nima → 409, aporta centerId). Valida un id de ' +
            'catálogo solo si se aporta. Si aportas authId+autorizacion, hace también el upsert de la autorización.',
        {
            clientId: z.number().int().describe('clientId de la entidad padre (requerido; debe existir).'),
            centerId: z.number().int().optional().describe('Identidad explícita del centro (si se conoce).'),
            nima: z.number().int().optional().describe('NIMA para identificar el centro si no hay centerId.'),
            nombre: z.string().optional(),
            direccion: z.string().optional(),
            ciudad: z.string().optional(),
            cp: z.string().optional(),
            regionId: z.number().int().optional(),
            provinceId: z.number().int().optional(),
            localityId: z.number().int().optional(),
            vialId: z.number().int().optional(),
            codigoCnae: z.string().optional().describe('Código CNAE (varchar(4), PK de IneCnae).'),
            telefono: z.string().optional(),
            mail: z.string().optional(),
            authId: z.string().optional().describe('Tipo de autorización (T01/G0x) — con autorizacion, hace el upsert.'),
            autorizacion: z.string().optional().describe('Número de registro de la autorización (lo aporta el humano).'),
        },
        async (args) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            const res = await client.post<UpsertCentroResult>(
                '/mwm/retirada/upsert-centro',
                { confirm: true, ...args }
            )

            const verbo = res.outcome === 'created' ? 'creado' : 'actualizado'
            return {
                content: [{
                    type: 'text' as const,
                    text: `Centro **${verbo}** — clientId \`${res.clientId}\`, centerId \`${res.centerId}\`.`,
                }],
            }
        }
    )
}
