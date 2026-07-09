import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCenterList, parseAuthorizations, lookupNimaAuthorizations, type NimaCenterRef } from '../src/madrid-nima.js'

const FIX = join(process.cwd(), 'test', 'fixtures')
const searchHtml = readFileSync(join(FIX, 'cm-search-consenur.html'), 'utf-8')
const searchHtmlPage2 = readFileSync(join(FIX, 'cm-search-consenur-page2.html'), 'utf-8')
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

// cmPost always decodes the response body as ISO-8859-1 (Latin-1) now, matching the real CM
// service — so fixtures (read from disk as UTF-8 JS strings) must be re-encoded as Latin-1 bytes
// before being wrapped in a Response, otherwise cmPost's Latin-1 decode mangles the accented
// characters the fixtures contain (e.g. "Número" -> garbled -> the total-registros regex fails
// to match -> pagination silently stops after page 1).
function latin1Response(html: string): Response {
    return new Response(Buffer.from(html, 'latin1'), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=ISO-8859-1' },
    })
}

// A fake fetch that returns the search fixture for ConsultaNimaAccion and the ficha fixture for
// FichaNimaAccion (regardless of idCentro, for the test). Serves page 1 (posicionActual=0) vs
// page 2 (posicionActual>=10) of the search results so the posicionActual pagination path can be
// exercised without hitting the network.
function fakeFetch(searchHtml: string, fichaHtml: string, searchHtmlPage2?: string): typeof fetch {
    return (async (input: any, init?: any) => {
        const url = String(input)
        if (url.includes('FichaNimaAccion')) {
            return latin1Response(fichaHtml)
        }
        const body = String(init?.body ?? '')
        const posicionActual = Number(new URLSearchParams(body).get('posicionActual') ?? '0')
        const html = posicionActual >= 10 && searchHtmlPage2 ? searchHtmlPage2 : searchHtml
        return latin1Response(html)
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

test('lookupNimaAuthorizations paginates with posicionActual to pull the 11th center', async () => {
    // Without a target nima, the orchestrator must page past the first 10 rows (posicionActual=0)
    // to posicionActual=10 and pick up the 11th center (idCentro 242437) from the page-2 fixture.
    // accion_paginacion does nothing on the real CM service, so this only passes if the
    // implementation drives pagination off posicionActual.
    const res = await lookupNimaAuthorizations(
        { nif: 'B86208824' },
        fakeFetch(searchHtml, fichaHtml, searchHtmlPage2),
    )
    assert.equal(res.entidad.centros.length, 11, `expected 11 centros, got ${res.entidad.centros.length}`)
    assert.ok(
        res.entidad.centros.some(c => c.nima === 2810000011),
        'expected the 11th center (nima 2810000011) from the page-2 fixture to be included',
    )
})

test('lookupNimaAuthorizations breaks on a page that adds no new centers (Finding 2)', async () => {
    // Fake server ignores posicionActual entirely and always re-serves page 1's 10 centers,
    // while claiming total=11 (one more than it will ever actually deliver). Without the
    // no-progress break, the loop would burn all 10 page iterations before giving up; with the
    // fix, it should stop right after the 2nd search page adds nothing new.
    let searchCalls = 0
    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const url = String(input)
        if (url.includes('FichaNimaAccion')) {
            return latin1Response(fichaHtml)
        }
        searchCalls++
        return latin1Response(searchHtml)
    }) as unknown as typeof fetch

    const res = await lookupNimaAuthorizations({ nif: 'B86208824' }, fetchImpl)

    assert.equal(res.entidad.centros.length, 10, `expected 10 centros, got ${res.entidad.centros.length}`)
    assert.ok(searchCalls <= 2, `expected the no-progress break to fire by the 2nd search POST, got ${searchCalls} calls`)
})

test('lookupNimaAuthorizations keeps paging past a small/wrong total while a nima is still unfound (Finding 1)', async () => {
    // Page 1 under-reports "Número total de registros: 1" (a mis-parsed/drifted footer), even
    // though the requested nima (2810000011) only appears on page 2 (posicionActual=10, the
    // existing page-2 fixture). Without the fix, `centers.length >= total` (10 >= 1) would end
    // the loop after page 1 and the lookup would wrongly throw "not found".
    const searchHtmlPage1SmallTotal = searchHtml.replace(
        /Número total de registros:\s*11/,
        'Número total de registros: 1',
    )
    assert.notEqual(searchHtmlPage1SmallTotal, searchHtml, 'fixture replace did not match — check the footer text')

    const fetchImpl: typeof fetch = (async (input: any, init?: any) => {
        const url = String(input)
        if (url.includes('FichaNimaAccion')) {
            return latin1Response(fichaHtml)
        }
        const body = String(init?.body ?? '')
        const posicionActual = Number(new URLSearchParams(body).get('posicionActual') ?? '0')
        const html = posicionActual >= 10 ? searchHtmlPage2 : searchHtmlPage1SmallTotal
        return latin1Response(html)
    }) as unknown as typeof fetch

    const res = await lookupNimaAuthorizations({ nif: 'B86208824', nima: 2810000011 }, fetchImpl)

    assert.equal(res.entidad.centros.length, 1, `expected 1 centro, got ${res.entidad.centros.length}`)
    assert.equal(res.entidad.centros[0].nima, 2810000011)
})

test('cmPost decodes the CM response as ISO-8859-1, not UTF-8', async () => {
    // The CM serves Content-Type: text/html; charset=ISO-8859-1 even though the in-page <meta>
    // lies and claims UTF-8. Feed raw Latin-1 bytes for a `Razón Social:` line (0xf3 = 'ó' in
    // Latin-1) and assert the accent survives — this locks in the TextDecoder('iso-8859-1') fix
    // so a future refactor can't silently revert to res.text() (UTF-8).
    const latin1Html = Buffer.from(
        '<html><body><table><tr><td><b>Razón Social:</b> ACME</td></tr></table></body></html>',
        'latin1',
    )
    // Drive it through lookupNimaAuthorizations's ficha fetch: fake the search step to return one
    // center, then let the ficha fetch return the Latin-1 bytes above.
    const searchThenLatin1: typeof fetch = (async (input: any, init?: any) => {
        const url = String(input)
        if (url.includes('FichaNimaAccion')) {
            return new Response(latin1Html, { status: 200, headers: { 'Content-Type': 'text/html; charset=ISO-8859-1' } })
        }
        return latin1Response(searchHtml)
    }) as unknown as typeof fetch

    const res = await lookupNimaAuthorizations({ nif: 'B86208824', nima: 2800006779 }, searchThenLatin1)
    assert.equal(res.entidad.nombre, 'ACME', `expected razonSocial to decode with the accent, got: ${res.entidad.nombre}`)
})
