import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePdf, MAX_PDF_BYTES, formatChain, formatWarnings } from '../src/tools/nt-final-gestor.js'

test('validatePdf acepta un PDF con magic bytes y tamaño válido', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100)])
    const res = validatePdf(pdf)
    assert.equal(res.ok, true)
})

test('validatePdf rechaza bytes sin cabecera %PDF', () => {
    const notPdf = Buffer.from('PK\x03\x04 esto es un zip')
    const res = validatePdf(notPdf)
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /PDF/)
})

test('validatePdf rechaza un PDF mayor que el límite', () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(MAX_PDF_BYTES + 1)])
    const res = validatePdf(big)
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /25|tamaño|grande/i)
})

test('formatChain numera los eslabones en orden con su operación', () => {
    const md = formatChain([
        { orden: 1, clientId: 17, centerId: 1, operacion: 'D13' },
        { orden: 2, clientId: 21, centerId: 3, operacion: 'D09' },
    ])
    const lineas = md.split('\n')
    assert.equal(lineas.length, 2)
    assert.match(lineas[0], /1\..*entidad 17.*centro 1.*D13/)
    assert.match(lineas[1], /2\..*entidad 21.*centro 3.*D09/)
})

test('formatChain con un solo eslabón produce una línea', () => {
    const md = formatChain([{ orden: 1, clientId: 17, centerId: 1, operacion: 'D10' }])
    assert.equal(md.split('\n').length, 1)
    assert.match(md, /D10/)
})

test('formatChain sin eslabones dice que no hay cadena', () => {
    assert.match(formatChain([]), /sin cadena|vacía/i)
})

test('formatWarnings lista los avisos E3L y aclara que NO bloquean', () => {
    const md = formatWarnings(['eslabón 1 (entidad 17 / centro 1): el centro final no tiene el LER 180106*'])
    assert.match(md, /180106/)
    assert.match(md, /no bloquea|no impide/i)
})

test('formatWarnings sin avisos devuelve cadena vacía (no ensucia el markdown)', () => {
    assert.equal(formatWarnings([]), '')
})

test('render defensivo: respuesta sin cadena/avisosE3l (backend viejo) no lanza', () => {
    // Durante la ventana de dos fases el MCP nuevo puede pegar contra un backend
    // cuya respuesta aún no trae cadena/avisosE3l → deben rendir "sin cadena" / "" sin excepción.
    const respuesta: Record<string, unknown> = { proposalId: 'p1', ntNumero: 'NT1' }
    const cadena = (respuesta.cadena as Parameters<typeof formatChain>[0] | undefined) ?? []
    const avisos = (respuesta.avisosE3l as Parameters<typeof formatWarnings>[0] | undefined) ?? []
    assert.doesNotThrow(() => formatChain(cadena))
    assert.doesNotThrow(() => formatWarnings(avisos))
    assert.match(formatChain(cadena), /sin cadena|vacía/i)
    assert.equal(formatWarnings(avisos), '')
})
