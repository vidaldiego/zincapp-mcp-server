import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    rasterizePdfToPngs,
    formatSeriesList,
    formatJsonBlock,
    renderErrorHint,
    PAGE_WIDTH,
    DEFAULT_RENDER_PAGES,
    MAX_RENDER_PAGES,
} from '../src/tools/printables.js'

// ── Fixture: un PDF mínimo construido a mano (pdfjs reconstruye el xref; una caja azul por página) ──

function minimalPdf(pages: number): Buffer {
    const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')
    const objs: string[] = [
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        `2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages} >> endobj`,
    ]
    for (let i = 0; i < pages; i++) {
        const pageObj = 3 + i * 2
        const contentObj = pageObj + 1
        objs.push(
            `${pageObj} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents ${contentObj} 0 R >> endobj`,
            `${contentObj} 0 obj << /Length 44 >> stream`,
            '0.2 0.4 0.8 rg 20 20 160 60 re f',
            'endstream endobj',
        )
    }
    const body = ['%PDF-1.4', ...objs, `trailer << /Root 1 0 R /Size ${3 + pages * 2} >>`, '%%EOF']
    return Buffer.from(body.join('\n'), 'latin1')
}

/** Ancho declarado en el IHDR de un PNG (bytes 16-19, big-endian). */
function pngWidth(png: Buffer): number {
    return png.readUInt32BE(16)
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

test('rasterizePdfToPngs devuelve un PNG por página con el ancho del portal', async () => {
    const { pageCount, pngs } = await rasterizePdfToPngs(minimalPdf(1), DEFAULT_RENDER_PAGES)
    assert.equal(pageCount, 1)
    assert.equal(pngs.length, 1)
    assert.ok(pngs[0].subarray(0, 4).equals(PNG_MAGIC), 'no es un PNG')
    assert.equal(pngWidth(pngs[0]), PAGE_WIDTH)
})

test('rasterizePdfToPngs respeta maxPages y reporta el total real', async () => {
    const { pageCount, pngs } = await rasterizePdfToPngs(minimalPdf(3), 2)
    assert.equal(pageCount, 3, 'pageCount debe ser el total del PDF')
    assert.equal(pngs.length, 2, 'sólo maxPages imágenes')
    for (const p of pngs) assert.ok(p.subarray(0, 4).equals(PNG_MAGIC))
})

test('rasterizePdfToPngs rechaza bytes que no son un PDF', async () => {
    await assert.rejects(rasterizePdfToPngs(Buffer.from('no soy un pdf'), 1))
})

test('los límites de render son sensatos (default ≤ máximo)', () => {
    assert.ok(DEFAULT_RENDER_PAGES >= 1)
    assert.ok(DEFAULT_RENDER_PAGES <= MAX_RENDER_PAGES)
})

test('formatSeriesList lista uuid en código, título y estilo', () => {
    const md = formatSeriesList([
        { seriesUuid: 'abc-123', module: 'facturacion', document: 'factura', title: 'Factura A4', style: 'clasico' },
        { seriesUuid: 'def-456', module: null, document: null, title: null, style: null },
    ])
    const lines = md.split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], /`abc-123`/)
    assert.match(lines[0], /Factura A4/)
    assert.match(lines[0], /facturacion \/ factura/)
    assert.match(lines[0], /clasico/)
    assert.match(lines[1], /`def-456`/)
    assert.match(lines[1], /sin título/)
})

test('formatSeriesList sin series lo dice en claro', () => {
    assert.match(formatSeriesList([]), /No hay series/)
})

test('formatJsonBlock produce JSON pretty en bloque de código', () => {
    const md = formatJsonBlock({ a: 1, b: [true] })
    assert.ok(md.startsWith('```json\n'))
    assert.ok(md.endsWith('\n```'))
    assert.deepEqual(JSON.parse(md.slice(8, -4)), { a: 1, b: [true] })
})

test('formatJsonBlock con null (modelo ausente) no lanza', () => {
    assert.match(formatJsonBlock(null), /null/)
})

test('renderErrorHint mapea el 409 de sesión de render a "re-elévate en la web"', () => {
    const hint = renderErrorHint(
        'API error 409: {"error":"No render session is stored for this elevation — re-elevate in the web to capture one, then retry"}',
    )
    assert.match(hint, /elevarte desde el portal web/i)
    assert.match(hint, /No render session/, 'conserva el detalle del backend')
})

test('renderErrorHint deja pasar los demás errores con su detalle', () => {
    const hint = renderErrorHint('API error 404: series not found')
    assert.match(hint, /404: series not found/)
    assert.doesNotMatch(hint, /elevarte desde el portal web/i)
})
