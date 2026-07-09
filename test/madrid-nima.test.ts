import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCenterList, parseAuthorizations, type NimaCenterRef } from '../src/madrid-nima.js'

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
