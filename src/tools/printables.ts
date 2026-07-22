import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { resolveElevation } from './elevation.js'

// ── Backend DTOs (AgentPrintableEndpoint.kt — the zat_ agent surface) ──────────────────────────
//
// GET  /agent/v1/printable/series                → SeriesSummary[]
// GET  /agent/v1/printable/series/{uuid}/model   → ModelResponse
// PUT  /agent/v1/printable/series/{uuid}/model   ← { confirm: true, model }        → ModelResponse
// GET  /agent/v1/printable/series/{uuid}/style   → StyleResponse
// PUT  /agent/v1/printable/series/{uuid}/style   ← { confirm: true, definition }   → StyleResponse
// POST /agent/v1/printable/series/{uuid}/render  ← { theme?, lang?, testData? }    → RenderResponse
//
// Reads/writes need only the operator's `printables` grant (NO elevation). Render is the ONE
// exception: it needs a live WEB-opened elevation (the backend replays the elevate-time sessid
// against the elevated tenant's portal). No request ever carries a companyId, host, path, cookie
// or identity — the render body is presentation knobs ONLY (the confused-deputy contract).

interface SeriesSummary {
    seriesUuid: string
    module: string | null
    document: string | null
    title: string | null
    style: string | null
}

interface ModelResponse {
    seriesUuid: string
    model: Record<string, unknown> | null
}

interface StyleResponse {
    style: string
    definition: Record<string, unknown> | null
}

interface RenderResponse {
    pdfBase64: string
    pageCount: number
}

// ── Rasterisation constants (mirrors the portal's renderPdfPages, pdf-images.ts) ──────────────

/** Page raster width in px — same as the portal's PAGE_WIDTH so the agent sees what the studio sees. */
export const PAGE_WIDTH = 800
/** Default pages rasterised per render — the portal's MAX_PAGES. */
export const DEFAULT_RENDER_PAGES = 3
/** Hard cap on pages per render (image content is expensive for the model). */
export const MAX_RENDER_PAGES = 8

/**
 * Rasterise a PDF to page PNGs — the Node twin of the portal's `renderPdfPages`
 * (zn-web-app-v1 `printables/utils/pdf-images.ts`): pdfjs render at a fixed page width, one
 * image per page, capped. Browser canvas → `@napi-rs/canvas`; JPEG → PNG (lossless proves
 * layout: hairlines, kerning and 1px borders survive). Exported for tests.
 */
export async function rasterizePdfToPngs(
    pdf: Buffer,
    maxPages: number,
    pageWidth: number = PAGE_WIDTH,
): Promise<{ pageCount: number; pngs: Buffer[] }> {
    // Dynamic imports: pdfjs is a multi-MB parse and the canvas binding is native — only render pays.
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const { createCanvas } = await import('@napi-rs/canvas')

    const doc = await getDocument({
        data: new Uint8Array(pdf),
        isEvalSupported: false,
    }).promise
    try {
        const pageCount = doc.numPages
        const toRender = Math.min(pageCount, maxPages)
        const pngs: Buffer[] = []
        for (let i = 1; i <= toRender; i++) {
            const page = await doc.getPage(i)
            const base = page.getViewport({ scale: 1 })
            const viewport = page.getViewport({ scale: pageWidth / base.width })
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
            const ctx = canvas.getContext('2d')
            await page.render({
                canvasContext: ctx as unknown as CanvasRenderingContext2D,
                viewport,
            }).promise
            pngs.push(canvas.toBuffer('image/png'))
        }
        return { pageCount, pngs }
    } finally {
        await doc.destroy()
    }
}

// ── Pure formatting helpers (exported for tests) ───────────────────────────────────────────────

/** Una línea por serie, con el uuid en código para copiar/pegar en las demás herramientas. */
export function formatSeriesList(series: SeriesSummary[]): string {
    if (series.length === 0) return 'No hay series de printables.'
    return series
        .map((s) => {
            const title = s.title ?? '(sin título)'
            const doc = [s.module, s.document].filter(Boolean).join(' / ') || '—'
            return `- **${title}** · \`${s.seriesUuid}\` · ${doc} · estilo: ${s.style ?? '—'}`
        })
        .join('\n')
}

/** JSON pretty en bloque de código — el modelo/estilo se lee y se re-manda ENTERO al actualizar. */
export function formatJsonBlock(obj: unknown): string {
    return '```json\n' + JSON.stringify(obj ?? null, null, 2) + '\n```'
}

/**
 * Traduce el error del POST de render a una acción para el operador. El 409 característico es
 * "No render session is stored for this elevation" — la elevación está viva pero el backend no
 * capturó el sessid al elevarte (elevate lo captura best-effort): la salida es re-elevarte en la
 * web. Cualquier otro error se muestra tal cual (el backend ya habla claro).
 */
export function renderErrorHint(message: string): string {
    if (/render session/i.test(message)) {
        return (
            '# Render no disponible\n\n' +
            'Tu elevación está abierta pero no tiene sesión de render capturada (se captura al ' +
            'elevar, best-effort). Cierra la elevación y **vuelve a elevarte desde el portal web** ' +
            'para capturar una nueva, y relanza la herramienta.\n\n' +
            `_Detalle del backend:_ ${message}`
        )
    }
    return `# Error del render\n\n${message}`
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

// ── Tools ──────────────────────────────────────────────────────────────────────────────────────

export function registerPrintables(server: McpServer, client: ZincAppClient) {
    server.tool(
        'list_printable_series',
        'Lista el catálogo de series de printables de plataforma (documentos imprimibles: facturas, ' +
            'albaranes, tickets…): uuid, módulo/documento, título y estilo asignado. Sólo resúmenes — el ' +
            'modelo se lee con read_printable_model. Requiere el permiso de operador `printables`; NO ' +
            'requiere elevación (son datos globales de plataforma, sin tenant). Ningún parámetro de ' +
            'company, host ni identidad.',
        {},
        async () => {
            const series = await client.get<SeriesSummary[]>('/printable/series')
            return text(`# Series de printables (${series.length})\n\n${formatSeriesList(series)}`)
        },
    )

    server.tool(
        'read_printable_model',
        'Lee el MODELO completo (JSON) de una serie de printable — la definición del documento que ' +
            'edita el estudio de printables del portal. Léelo SIEMPRE antes de update_printable_model: ' +
            'la actualización reemplaza el modelo entero, así que tu edición parte de este JSON. ' +
            'Para entender lo que estás leyendo (tipos de nodo, propiedades, expresiones, referencias $), ' +
            'read_doc("printing.model-language"). ' +
            'Permiso `printables`; sin elevación.',
        {
            seriesUuid: z.string().describe('El uuid de la serie (de list_printable_series)'),
        },
        async ({ seriesUuid }) => {
            const m = await client.get<ModelResponse>(
                `/printable/series/${encodeURIComponent(seriesUuid)}/model`,
            )
            return text(`# Modelo · serie ${m.seriesUuid}\n\n${formatJsonBlock(m.model)}`)
        },
    )

    server.tool(
        'update_printable_model',
        'REEMPLAZA el modelo (JSON completo) de una serie de printable. Flujo lectura→edición: lee el ' +
            'modelo actual con read_printable_model, aplica tu cambio sobre ese JSON y manda aquí el ' +
            'MODELO ENTERO resultante (no un parche — lo que mandes es lo que queda). El backend guarda ' +
            'un snapshot de versión antes de sobrescribir (mismo camino guardado que usa el portal). ' +
            'Sólo aplica cambios que hayas revisado. Permiso `printables`; sin elevación. Verifica el ' +
            'resultado visualmente con render_printable.\n\n' +
            'ANTES DE EDITAR, lee la referencia del lenguaje de modelos: read_doc("printing.model-language"). ' +
            'Define los tipos de nodo válidos, las propiedades que el renderer lee de verdad, las expresiones ' +
            '${...}, i18n y las referencias $. Un nodo con una propiedad que el renderer NO lee (p.ej. un ' +
            'literal HTML) se renderiza como un <div> vacío SIN ERROR: el PDF sale, pero sin tu contenido. ' +
            'Ver read_doc("printing.recipes") para pitfalls y modos de fallo.',
        {
            seriesUuid: z.string().describe('El uuid de la serie (de list_printable_series)'),
            model: z
                .record(z.string(), z.unknown())
                .describe('El modelo COMPLETO resultante (JSON de read_printable_model con tu edición)'),
        },
        async ({ seriesUuid, model }) => {
            const updated = await client.put<ModelResponse>(
                `/printable/series/${encodeURIComponent(seriesUuid)}/model`,
                { confirm: true, model },
            )
            return text(
                `# Modelo actualizado · serie ${updated.seriesUuid}\n\n` +
                    'El backend guardó un snapshot de la versión anterior antes de sobrescribir.\n\n' +
                    `Modelo vigente:\n${formatJsonBlock(updated.model)}\n\n` +
                    '_Comprueba el resultado con `render_printable` (requiere elevación web activa)._',
            )
        },
    )

    server.tool(
        'read_printable_style',
        'Lee la DEFINICIÓN DE ESTILO (JSON) asignada a una serie de printable (colores, fuentes, ' +
            'espaciados…). Ojo: el estilo es COMPARTIDO — otras series con el mismo estilo también lo ' +
            'usan. Léelo siempre antes de update_printable_style. Permiso `printables`; sin elevación.',
        {
            seriesUuid: z.string().describe('El uuid de la serie cuyo estilo quieres leer'),
        },
        async ({ seriesUuid }) => {
            const s = await client.get<StyleResponse>(
                `/printable/series/${encodeURIComponent(seriesUuid)}/style`,
            )
            return text(`# Estilo \`${s.style}\`\n\n${formatJsonBlock(s.definition)}`)
        },
    )

    server.tool(
        'update_printable_style',
        'REEMPLAZA la definición del estilo asignado a una serie. Mismo flujo lectura→edición que el ' +
            'modelo: lee con read_printable_style, edita ese JSON y manda la DEFINICIÓN ENTERA. ' +
            'ATENCIÓN: el estilo es compartido entre series — tu cambio afecta a TODAS las series que ' +
            'lo usen, no sólo a ésta. El backend guarda snapshot de versión antes de sobrescribir. ' +
            'Permiso `printables`; sin elevación. Verifica con render_printable.\n\n' +
            'ANTES DE EDITAR, lee read_doc("printing.data-and-styles"): explica qué se comparte entre series, ' +
            'qué sobrescribe a qué (modelo vs estilo vs tema) y el alcance real de un cambio de estilo. ' +
            'Comprueba primero con list_printable_series qué series usan este mismo estilo.',
        {
            seriesUuid: z.string().describe('El uuid de la serie cuyo estilo quieres actualizar'),
            definition: z
                .record(z.string(), z.unknown())
                .describe('La definición COMPLETA resultante (JSON de read_printable_style con tu edición)'),
        },
        async ({ seriesUuid, definition }) => {
            const updated = await client.put<StyleResponse>(
                `/printable/series/${encodeURIComponent(seriesUuid)}/style`,
                { confirm: true, definition },
            )
            return text(
                `# Estilo \`${updated.style}\` actualizado\n\n` +
                    'El backend guardó un snapshot de la versión anterior. Recuerda: el estilo es ' +
                    'compartido — afecta a todas las series que lo usan.\n\n' +
                    `Definición vigente:\n${formatJsonBlock(updated.definition)}\n\n` +
                    '_Comprueba el resultado con `render_printable` (requiere elevación web activa)._',
            )
        },
    )

    server.tool(
        'render_printable',
        'Renderiza una serie de printable a PDF en el servidor y te devuelve las páginas como ' +
            'IMÁGENES PNG para que las VEAS y juzgues la maquetación (tras un update_printable_model / ' +
            '_style). REQUIERE tu elevación de operador ABIERTA EN LA WEB: el backend renderiza contra ' +
            'el portal del tenant elevado reutilizando la sesión capturada al elevarte — esta ' +
            'herramienta nunca abre una elevación ni acepta company, host o cookie. El cuerpo lleva ' +
            'sólo presentación: theme, lang y testData (ids de documentos de prueba). Salida PNG ' +
            `a ${PAGE_WIDTH}px de ancho (el formato HTML no está expuesto por el canal agente).`,
        {
            seriesUuid: z.string().describe('El uuid de la serie a renderizar'),
            theme: z.string().optional().describe('Tema de render (por defecto el test-theme del modelo, o "black")'),
            lang: z.string().optional().describe('Idioma del documento (por defecto el test-lang del modelo, o "es")'),
            testData: z
                .string()
                .optional()
                .describe('Ids de documentos de prueba, separados por comas (p.ej. "15,16"); por defecto el test-data del modelo'),
            maxPages: z
                .number()
                .int()
                .min(1)
                .max(MAX_RENDER_PAGES)
                .optional()
                .describe(`Páginas a devolver como imagen (1-${MAX_RENDER_PAGES}; por defecto ${DEFAULT_RENDER_PAGES})`),
        },
        async ({ seriesUuid, theme, lang, testData, maxPages }) => {
            // La elevación se abre en la web — si no hay, guía al operador en vez de un HTTP opaco.
            const elev = await resolveElevation(client)
            if ('content' in elev) return elev

            let r: RenderResponse
            try {
                r = await client.post<RenderResponse>(
                    `/printable/series/${encodeURIComponent(seriesUuid)}/render`,
                    { theme, lang, testData },
                )
            } catch (e) {
                return text(renderErrorHint((e as Error).message))
            }

            const pdf = Buffer.from(r.pdfBase64, 'base64')
            const { pageCount, pngs } = await rasterizePdfToPngs(pdf, maxPages ?? DEFAULT_RENDER_PAGES)
            const truncated = pngs.length < pageCount
                ? ` (mostrando ${pngs.length}; sube maxPages para ver más)`
                : ''
            return {
                content: [
                    {
                        type: 'text' as const,
                        text:
                            `# Render · serie ${seriesUuid} · company ${elev.companyId}\n` +
                            `${pageCount} página(s)${truncated} · PNG a ${PAGE_WIDTH}px`,
                    },
                    ...pngs.map((p) => ({
                        type: 'image' as const,
                        data: p.toString('base64'),
                        mimeType: 'image/png',
                    })),
                ],
            }
        },
    )
}
