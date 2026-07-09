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

export interface NimaAuthorization {
    authId: string
    autorizacion: string
    estado: boolean
}

/** Collapse an HTML fragment to plain text (strip tags, decode &nbsp;, squash whitespace). */
function pText(s: string): string {
    return s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Parse the FichaNimaAccion.icm detail into the razón social, the center NIMA, and its
 * authorizations (verified against test/fixtures/cm-ficha-consenur-90181.html).
 *
 * Razón Social and NIMA come from the "Sede"/"Centro" fieldsets:
 *   - `<b>Razón Social:</b> CONSENUR SANITARIOS, S.L.</td>` — plain text between the label and the cell close.
 *   - `var nima = '2800006779';` — a JS literal inside the NIMA cell (the surrounding
 *     `document.write(nima)` is a UI-only rendering detail we ignore, same as parseCenterList).
 *
 * The "Autorizaciones" table rows are `Tipo | Nº | Estado | …4 date cells… | Consultar button`,
 * one row per authorization type held by the center. The real markup has malformed nested
 * `<tr>`s (`<tr>\n<tr bgcolor="...">`) which we don't need to care about since we match on
 * `<td>`/`<p>` boundaries rather than row boundaries. We map:
 *   authId = code before ' - ' in the Tipo cell, uppercased ('G01 - Centro Gestor…' -> 'G01')
 *   autorizacion = the Nº Autorización cell's text
 *   estado = true iff the Estado cell's text is exactly 'Autorizado/Registrado' (else e.g. 'Baja' -> false)
 * We scope the match to the text after the "Autorizaciones" heading so unrelated <p>s
 * elsewhere in the page can't be mistaken for a row.
 */
export function parseAuthorizations(html: string): {
    razonSocial: string | null
    nima: number | null
    autorizaciones: NimaAuthorization[]
} {
    const rs = html.match(/Razón Social:<\/b>\s*([^<]+?)\s*<\/td>/)
    const razonSocial = rs ? rs[1].trim() : null

    const nm = html.match(/var nima\s*=\s*'(\d+)'/)
    const nima = nm ? Number(nm[1]) : null

    const fsStart = html.indexOf('Autorizaciones')
    const scope = fsStart >= 0 ? html.slice(fsStart) : html

    const autorizaciones: NimaAuthorization[] = []
    // Tipo cell's "<code> - <desc>" <p>, then the next two <td> cells (Nº, Estado) in document order.
    const rowRe = /<p>\s*([A-Z]\d{2})\s*-[^<]*<\/p>[\s\S]*?<td[^>]*>\s*([\s\S]*?)<\/td>\s*<td[^>]*>\s*([\s\S]*?)<\/td>/g
    let m: RegExpExecArray | null
    while ((m = rowRe.exec(scope)) !== null) {
        const authId = m[1].toUpperCase()
        const numero = pText(m[2])
        const estadoText = pText(m[3])
        if (!numero) continue
        autorizaciones.push({
            authId,
            autorizacion: numero,
            estado: estadoText === 'Autorizado/Registrado',
        })
    }

    return { razonSocial, nima, autorizaciones }
}
