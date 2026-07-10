import { z } from 'zod'
import { readFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

/** Límite de tamaño de PDF, alineado con el importer (LapazImportEndpoint.kt:62 → 25 MB/PDF). */
export const MAX_PDF_BYTES = 25 * 1024 * 1024

/** Valida que los bytes son un PDF (`%PDF` magic) y no exceden el límite. Puro y exportado para test. */
export function validatePdf(bytes: Buffer): { ok: true } | { ok: false; error: string } {
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { ok: false, error: 'El fichero no es un PDF (no empieza por "%PDF-").' }
    }
    if (bytes.length > MAX_PDF_BYTES) {
        return { ok: false, error: `El PDF es demasiado grande (${bytes.length} bytes; máximo ${MAX_PDF_BYTES}, 25 MB).` }
    }
    return { ok: true }
}

/** Resuelve el base64 del PDF desde EXACTAMENTE uno de pdfPath | pdfBase64. */
function resolvePdfBase64(
    pdfPath: string | undefined,
    pdfBase64: string | undefined,
): { ok: true; base64: string } | { ok: false; error: string } {
    const hasPath = typeof pdfPath === 'string' && pdfPath.length > 0
    const hasB64 = typeof pdfBase64 === 'string' && pdfBase64.length > 0
    if (hasPath === hasB64) {
        return { ok: false, error: 'Aporta EXACTAMENTE uno de pdfPath o pdfBase64 (no ambos, no ninguno).' }
    }
    let bytes: Buffer
    if (hasPath) {
        try {
            bytes = readFileSync(pdfPath!)
        } catch (e) {
            return { ok: false, error: `No pude leer el PDF en '${pdfPath}': ${(e as Error).message}` }
        }
    } else {
        try {
            bytes = Buffer.from(pdfBase64!, 'base64')
        } catch (e) {
            return { ok: false, error: `pdfBase64 no es base64 válido: ${(e as Error).message}` }
        }
    }
    const v = validatePdf(bytes)
    if (!v.ok) return v
    return { ok: true, base64: bytes.toString('base64') }
}

interface ProposalDto {
    proposalId: string
    ntNumero: string
    ntNumeroDocumento: string | null
    gestorFinal: { clientId: number | null; centerId: number | null; operacion: string | null } | null
    ternaActual: { clientId: number | null; centerId: number | null; operacion: string | null } | null
    resoluble: boolean
    razon: string | null
}

interface ApplyResult {
    outcome: string
    ntNumero: string
    gestorFinal: { clientId: number | null; centerId: number | null; operacion: string | null } | null
}

const errorContent = (text: string) => ({ content: [{ type: 'text' as const, text }] })

export function registerNtFinalGestor(server: McpServer, client: ZincAppClient) {
    server.tool(
        'preview_nt_final_gestor',
        'DRY-RUN: extrae por IA el "Gestor final para la operación Dxx" del PDF de una Notificación Previa ' +
            '(NT), lo resuelve contra las entidades/centros de tu tenant, valida las invariantes E3L ' +
            '(operación en Table2Type + autorización por LER del centro), y devuelve una PROPUESTA opaca ' +
            '(con proposalId) SIN escribir nada. Aporta el PDF con pdfPath (ruta local) o pdfBase64 ' +
            '(exactamente uno). Revisa la propuesta y, si es correcta, aplícala con apply_nt_final_gestor. ' +
            'Corre bajo tu elevación de operador (company derivada de ella).',
        {
            ntNumero: z.string().describe('El número de la NT objetivo (p.ej. "NT30280008283420220064303")'),
            pdfPath: z.string().optional().describe('Ruta local al PDF de la NT (alternativa a pdfBase64)'),
            pdfBase64: z.string().optional().describe('El PDF de la NT en base64 (alternativa a pdfPath)'),
        },
        async ({ ntNumero, pdfPath, pdfBase64 }) => {
            const pdf = resolvePdfBase64(pdfPath, pdfBase64)
            if (!pdf.ok) return errorContent(`# Error\n${pdf.error}`)

            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            const p = await client.post<ProposalDto>(
                '/mwm/retirada/preview-nt-final-gestor',
                { ntNumero, pdfBase64: pdf.base64 },
            )

            if (!p.resoluble) {
                return errorContent(
                    `# Propuesta · NT ${p.ntNumero} — NO RESOLUBLE\n\n` +
                    `**Razón:** ${p.razon ?? 'desconocida'}\n\n` +
                    `Terna actual en la NT: ${fmtTriple(p.ternaActual)}. No se ha persistido nada.`,
                )
            }
            const text =
                `# Propuesta · NT ${p.ntNumero}\n\n` +
                `- **proposalId:** \`${p.proposalId}\`\n` +
                `- **Nº de NT en el documento:** ${p.ntNumeroDocumento ?? '—'}\n` +
                `- **Gestor final propuesto:** ${fmtTriple(p.gestorFinal)}\n` +
                `- **Terna actual en la NT:** ${fmtTriple(p.ternaActual)}\n\n` +
                `Si es correcto, aplica con \`apply_nt_final_gestor({ proposalId: "${p.proposalId}" })\`. ` +
                `La propuesta caduca (TTL) — aplícala pronto.`
            return { content: [{ type: 'text' as const, text }] }
        },
    )

    server.tool(
        'apply_nt_final_gestor',
        'Aplica una propuesta de gestor final previamente revisada (por proposalId de preview_nt_final_gestor). ' +
            'NO re-ejecuta la IA ni re-transporta el PDF. Escribe la terna (clientId, centerId, operación) en ' +
            'la NT bajo tu elevación de operador, por el framework (hooks + auditoría), con regla ' +
            'complete-what\'s-missing (si la NT ya tiene un gestor final distinto → conflicto, no se ' +
            'sobrescribe). Sólo aplica propuestas que hayas verificado.',
        {
            proposalId: z.string().describe('El proposalId devuelto por preview_nt_final_gestor'),
        },
        async ({ proposalId }) => {
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            const r = await client.post<ApplyResult>(
                '/mwm/retirada/apply-nt-final-gestor',
                { proposalId },
            )
            const titulo = r.outcome === 'applied'
                ? `# Aplicado · NT ${r.ntNumero}`
                : `# Sin cambios · NT ${r.ntNumero}`
            const text =
                `${titulo}\n\n` +
                `- **Resultado:** ${r.outcome}\n` +
                `- **Gestor final:** ${fmtTriple(r.gestorFinal)}\n\n` +
                `_Recuerda des-elevarte desde el portal web con un motivo cuando termines._`
            return { content: [{ type: 'text' as const, text }] }
        },
    )
}

function fmtTriple(t: { clientId: number | null; centerId: number | null; operacion: string | null } | null): string {
    if (!t || (t.clientId == null && t.centerId == null && t.operacion == null)) return '(vacía)'
    return `entidad ${t.clientId ?? '—'} / centro ${t.centerId ?? '—'} · operación ${t.operacion ?? '—'}`
}
