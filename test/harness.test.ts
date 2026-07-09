import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIX = join(process.cwd(), 'test', 'fixtures')

test('fixtures are present and non-empty', () => {
    const search = readFileSync(join(FIX, 'cm-search-consenur.html'), 'utf-8')
    const ficha = readFileSync(join(FIX, 'cm-ficha-consenur-90181.html'), 'utf-8')
    assert.ok(search.includes('Número total de registros'), 'search fixture looks wrong')
    assert.ok(ficha.includes('Autorizaciones'), 'ficha fixture looks wrong')
})
