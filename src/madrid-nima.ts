export interface NimaCenterRef {
    nima: number
    idCentro: number
    tipoCentro: string
    direccion: string
}

/**
 * Parse the ConsultaNimaAccion.icm search response into center refs.
 *
 * Each result row in the CM search table follows this fixed document order
 * (verified against test/fixtures/cm-search-consenur.html):
 *   1. NIMA cell: a `<script>` literal `var nima='2800006779';` followed by a
 *      UI-only filter `nima.substring(2,5) != '913'` that gates a `document.write`
 *      call — we read the JS literal directly and ignore that filter entirely.
 *   2. Province/municipality cell (`<p>…</p>`) — not needed here.
 *   3. Address cell (`<p>…</p>`) — captured as `direccion`.
 *   4. A "Consultar" button `onclick="consultar('form',<idCentro>,'<tipoCentro>')"`.
 *
 * NIMA and idCentro are different identifiers for the same center (e.g. nima
 * 2800082834 has idCentro 82834; nima 2800006779 has idCentro 90181) — they are
 * NOT derivable from one another, so each row's nima/address must be aligned
 * with that same row's idCentro/tipoCentro by document order, not by value.
 *
 * We match one row at a time with a single regex spanning nima → address →
 * consultar(), rather than two separate passes, since the fixture shows rows
 * never interleave (each row's four fields appear back-to-back before the next
 * row's nima literal starts).
 */
export function parseCenterList(html: string): { razonSocial: string | null; centros: NimaCenterRef[] } {
    const centros: NimaCenterRef[] = []

    const rowRe =
        /var nima\s*=\s*'(\d+)'[\s\S]*?<\/script>[\s\S]*?<p>([^<]*)<\/p>\s*<\/td>\s*<td[^>]*>\s*<p>([^<]*)<\/p>[\s\S]*?consultar\('form',\s*(\d+)\s*,\s*'([^']+)'\)/g

    let m: RegExpExecArray | null
    while ((m = rowRe.exec(html)) !== null) {
        const nima = Number(m[1])
        // m[2] is the province/municipality cell (unused); m[3] is the address cell.
        const direccion = m[3].trim()
        const idCentro = Number(m[4])
        const tipoCentro = m[5].trim()
        centros.push({ nima, idCentro, tipoCentro, direccion })
    }

    return { razonSocial: null, centros }
}
