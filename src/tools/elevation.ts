import type { ZincAppClient } from '../client.js'

/** The operator's current web-opened elevation, as seen through the agent token's account. */
export interface CurrentElevation {
    companyId: number | null
    elevated: boolean
}

/** A user-facing text result (the MCP tool content shape) — returned when NOT elevated. */
export type NotElevatedResult = { content: { type: 'text'; text: string }[] }

/**
 * Resolve the operator's active elevation for a retirada tool.
 *
 * The agent channel derives the tenant from the operator's WEB-opened elevation — no tool takes a
 * companyId, and the agent token NEVER opens an elevation itself (that needs the web step-up). This
 * helper hits `operator/current-elevation` and returns EITHER the elevated `companyId`, or a ready
 * user-facing message telling the operator to elevate in the web first.
 *
 * Usage:
 *   const elev = await resolveElevation(client)
 *   if ('content' in elev) return elev   // not elevated → surface the message
 *   const companyId = elev.companyId     // proceed under this tenant
 */
export async function resolveElevation(
    client: ZincAppClient,
): Promise<{ companyId: number } | NotElevatedResult> {
    const elev = await client.get<CurrentElevation>('/mwm/retirada/operator/current-elevation')
    if (!elev.elevated || elev.companyId == null) {
        return {
            content: [{
                type: 'text' as const,
                text:
                    'No estás elevado a ningún tenant. Elévate a la company objetivo desde el portal web ' +
                    '(IAM → elevar) con step-up, y luego vuelve a lanzar la herramienta. El token nunca ' +
                    'abre una elevación por sí mismo — actúa bajo la que tú abras en la web.',
            }],
        }
    }
    return { companyId: elev.companyId }
}
