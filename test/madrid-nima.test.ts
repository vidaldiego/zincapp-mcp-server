import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCenterList, parseAuthorizations, lookupNimaAuthorizations, type NimaCenterRef } from '../src/madrid-nima.js'

const FIX = join(process.cwd(), 'test', 'fixtures')
const searchHtml = readFileSync(join(FIX, 'cm-search-consenur.html'), 'utf-8')
const fichaHtml = readFileSync(join(FIX, 'cm-ficha-consenur-90181.html'), 'utf-8')

test('parseCenterList extracts all centers with nima/idCentro/tipo/direccion', () => {
    const { centros } = parseCenterList(searchHtml)
    // The CONSENUR search returns 11 total; the first page shows 10 rows.
    assert.ok(centros.length >= 10, `expected >=10 centers, got ${centros.length}`)

    const first = centros.find((c: NimaCenterRef) => c.nima === 2800082834)
    assert.ok(first, 'center 2800082834 missing')
    assert.equal(first!.tipoCentro, 'PCEA')
    assert.ok(first!.direccion.includes('RÍO EBRO'), `bad direccion: ${first!.direccion}`)

    const withId = centros.find((c: NimaCenterRef) => c.idCentro === 90181)
    assert.ok(withId, 'idCentro 90181 (nima 2800006779) missing')
    assert.equal(withId!.nima, 2800006779)
})

test('parseAuthorizations maps CM types to authId + estado', () => {
    const { autorizaciones, razonSocial, nima } = parseAuthorizations(fichaHtml)

    assert.equal(razonSocial, 'CONSENUR SANITARIOS, S.L.')
    assert.equal(nima, 2800006779)

    const g01 = autorizaciones.find(a => a.authId === 'G01')
    assert.ok(g01, 'G01 missing')
    assert.equal(g01!.autorizacion, 'AAI/MD/G11/08043')
    assert.equal(g01!.estado, true)

    const e01 = autorizaciones.find(a => a.authId === 'E01')
    assert.ok(e01, 'E01 missing')
    assert.equal(e01!.estado, false)   // 'Baja'

    // No transport authorization on this (gestor) center — the whole point of the project.
    assert.equal(autorizaciones.find(a => a.authId === 'T01'), undefined)
})

// A fake fetch that returns the search fixture for ConsultaNimaAccion and the ficha fixture for
// FichaNimaAccion (regardless of idCentro, for the test).
function fakeFetch(searchHtml: string, fichaHtml: string): typeof fetch {
    return (async (input: any, init?: any) => {
        const url = String(input)
        const html = url.includes('FichaNimaAccion') ? fichaHtml : searchHtml
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } })
    }) as unknown as typeof fetch
}

test('lookupNimaAuthorizations filters to the requested NIMA and returns nested graph', async () => {
    const res = await lookupNimaAuthorizations(
        { nif: 'B86208824', nima: 2800006779 },
        fakeFetch(searchHtml, fichaHtml),
    )
    assert.equal(res.entidad.cif, 'B86208824')
    assert.equal(res.entidad.centros.length, 1)
    assert.equal(res.entidad.centros[0].nima, 2800006779)
    const authIds = res.entidad.centros[0].autorizaciones.map((a: { authId: string }) => a.authId).sort()
    assert.deepEqual(authIds, ['E01', 'E02', 'G01', 'G04'])
})

test('lookupNimaAuthorizations throws a clean error when the NIMA is not among the centers', async () => {
    await assert.rejects(
        () => lookupNimaAuthorizations({ nif: 'B86208824', nima: 9999999999 }, fakeFetch(searchHtml, fichaHtml)),
        /NIMA 9999999999/,
    )
})
