import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePdf, MAX_PDF_BYTES } from '../src/tools/nt-final-gestor.js'

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
