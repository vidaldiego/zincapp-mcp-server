import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

interface ResolvedLink { clientId: number; centerId: number; codigoLer: string; residueId: number; authId: string }
interface UnresolvedLink { clientId: number; centerId: number; codigoLer: string; residueId: number; reason: string }
interface DryRun { year: number; total: number; resoluble: ResolvedLink[]; unresoluble: UnresolvedLink[] }
interface ApplyResult { year: number; applied: number; skipped: number; failed: { clientId: number; centerId: number; codigoLer: string; error: string }[]; unresoluble: UnresolvedLink[] }

export function registerLinkGestorAuthorizations(server: McpServer, client: ZincAppClient) {
    server.tool(
        'link_gestor_authorizations',
        'Backfill the missing gestor authorization LINK on a year\'s waste removals — the fix for the ' +
            'register\'s `autorizacion-gestor` gap. The importer created the gestor EntidadCentroLer rows ' +
            'with an empty auth_id; this links each to the center\'s already-loaded gestor authorization ' +
            '(G0x) using the SAME rule the register enforces (destino + hazard class). Without confirm it ' +
            'is a DRY-RUN (shows what would be linked and what can\'t resolve); with confirm=true it writes ' +
            'under your active operator elevation (company derived from it). Rows whose center has no ' +
            'matching destino authorization are reported, never forced — load the G0x with ' +
            'apply_authorization first. Read the dry-run before confirming.',
        {
            year: z.number().describe('Calendar year, e.g. 2025'),
            confirm: z.boolean().optional().describe('true to write; omit/false for a dry-run'),
        },
        async ({ year, confirm }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            const body = { year, confirm: confirm === true }
            const res = confirm === true
                ? await client.post<ApplyResult>('/mwm/retirada/link-gestor-authorizations', body)
                : await client.post<DryRun>('/mwm/retirada/link-gestor-authorizations', body)

            if (confirm !== true) {
                const d = res as DryRun
                const sampleR = d.resoluble.slice(0, 15).map(r => `  - ${r.clientId}/${r.centerId} · LER ${r.codigoLer} → \`${r.authId}\``).join('\n')
                const sampleU = d.unresoluble.slice(0, 15).map(u => `  - ${u.clientId}/${u.centerId} · LER ${u.codigoLer}: ${u.reason}`).join('\n')
                const text =
                    `# Dry-run · vincular autorización de gestor · ${d.year}\n` +
                    `${d.total} fila(s) EntidadCentroLer sin auth_id · ${d.resoluble.length} resolubles · ${d.unresoluble.length} sin resolver.\n\n` +
                    (d.resoluble.length ? `## Se vincularían (authId)\n${sampleR}${d.resoluble.length > 15 ? `\n  … +${d.resoluble.length - 15} más` : ''}\n\n` : '') +
                    (d.unresoluble.length ? `## No resolubles (falta cargar la G0x)\n${sampleU}${d.unresoluble.length > 15 ? `\n  … +${d.unresoluble.length - 15} más` : ''}\n\n` : '') +
                    `_Ejecuta con confirm=true para aplicar las ${d.resoluble.length} resolubles._`
                return { content: [{ type: 'text' as const, text }] }
            }

            const r = res as ApplyResult
            const failLines = r.failed.length ? '\n\n### Fallidas\n' + r.failed.map(f => `- ${f.clientId}/${f.centerId} LER ${f.codigoLer}: ${f.error}`).join('\n') : ''
            const text =
                `# Aplicado · vincular autorización de gestor · ${r.year}\n` +
                `${r.applied} vinculada(s)${r.skipped ? `, ${r.skipped} ya poblada(s)` : ''}${r.failed.length ? `, ${r.failed.length} con error` : ''}, bajo tu elevación.` +
                (r.unresoluble.length ? `\n${r.unresoluble.length} sin resolver (falta cargar su G0x — usa apply_authorization).` : '') +
                failLines +
                `\n\n_Recuerda des-elevarte desde el portal web con un motivo cuando termines._`
            return { content: [{ type: 'text' as const, text }] }
        }
    )
}
