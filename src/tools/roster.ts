import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { editInput, importRows, OfficeRoster, weekdays, weekInput } from './roster-office.js'

const id = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
const pagination = { first: z.number().int().positive().optional(), max: z.number().int().min(1).max(100).optional() }
const readOnly = { readOnlyHint: true, openWorldHint: false }
const localEdit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

function result(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

type ToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>

function safe<T>(handler: (input: T, context: ToolContext) => Promise<unknown>) {
    return async (input: T, context: ToolContext) => {
        try { return result(await handler(input, context)) }
        catch (error) {
            const message = error instanceof z.ZodError ? 'Los datos de la operación de cuadrante no son válidos.' :
                error instanceof Error ? error.message : 'No se pudo comprobar la operación de cuadrante.'
            return { isError: true, content: [{ type: 'text' as const, text: message }] }
        }
    }
}

export function registerOfficeRoster(server: McpServer, roster: OfficeRoster) {
    server.registerTool('attendance_roster_people', {
        description: 'Busca empleados autorizados por el perfil de RR. HH. configurado. Devuelve IDs para el cuadrante.',
        inputSchema: { search: z.string().max(160).optional(), ...pagination }, annotations: readOnly,
    }, safe(async ({ search, first, max }: { search?: string; first?: number; max?: number }) => roster.people(search, first ?? 1, max ?? 30)))

    server.registerTool('attendance_roster_models', {
        description: 'Lista los modelos de turno aptos para la semana indicada. Usa el UUID de versión exacto al asignar.',
        inputSchema: { week: weekInput.shape.week, days: weekdays.optional(), ...pagination }, annotations: readOnly,
    }, safe(async ({ week, first, max, days }: {
        week: string; first?: number; max?: number; days?: number[]
    }) => roster.models(week, first ?? 1, max ?? 30, days)))

    server.registerTool('attendance_roster_week', {
        description: 'Consulta la semana de las personas indicadas o un borrador local del MCP. pendingOnly resume fechas sin resolver.',
        inputSchema: { scope: weekInput.optional(), draftId: id.optional(), pendingOnly: z.boolean().optional() }, annotations: readOnly,
    }, safe(async ({ scope, draftId, pendingOnly }: {
        scope?: z.input<typeof weekInput>; draftId?: string; pendingOnly?: boolean
    }) => {
        if (draftId) {
            if (scope) throw new Error('Indica un borrador o un ámbito de semana.')
            return roster.inspect(draftId, pendingOnly ?? false)
        }
        if (!scope) throw new Error('Indica un borrador o un ámbito de semana.')
        return roster.week(scope, pendingOnly ?? false)
    }))

    server.registerTool('attendance_roster_init', {
        description: 'Crea un borrador privado local para IDs explícitos. Permite lunes a viernes, sábado o semana completa.',
        inputSchema: { scope: weekInput.omit({ view: true }), interval: z.enum(['weekdays', 'saturday', 'week']) }, annotations: localEdit,
    }, safe(async ({ scope, interval }: {
        scope: Omit<z.input<typeof weekInput>, 'view'>; interval: 'weekdays' | 'saturday' | 'week'
    }) => roster.init(scope, interval)))

    server.registerTool('attendance_roster_edit', {
        description: 'Prepara otro borrador con un turno, descanso, horario habitual o sección semanal para IDs explícitos. Devuelve el nuevo draftId.',
        inputSchema: { draftId: id, edit: editInput }, annotations: localEdit,
    }, safe(async ({ draftId, edit }: { draftId: string; edit: z.input<typeof editInput> }) => roster.edit(draftId, edit)))

    server.registerTool('attendance_roster_copy', {
        description: 'Copia una semana publicada a huecos del borrador, conserva excepciones y devuelve las filas omitidas.',
        inputSchema: { draftId: id, fromWeek: weekInput.shape.week }, annotations: localEdit,
    }, safe(async ({ draftId, fromWeek }: { draftId: string; fromWeek: string }) => roster.copy(draftId, fromWeek)))

    server.registerTool('attendance_roster_import', {
        description: 'Pasa una lista de asignaciones verificadas a un borrador privado. Resuelve con la persona cualquier nombre, turno o fecha ambigua antes de usarlo.',
        inputSchema: { draftId: id, rows: importRows }, annotations: localEdit,
    }, safe(async ({ draftId, rows }: { draftId: string; rows: z.input<typeof importRows> }) => roster.importAssignments(draftId, rows)))

    server.registerTool('attendance_roster_preview', {
        description: 'Solicita al servidor la revisión para guardar o publicar. Muestra cambios y bloqueos a la persona antes de pedir confirmación.',
        inputSchema: { draftId: id, action: z.enum(['save', 'publish']), reason: z.string().trim().min(1).max(1000) }, annotations: localEdit,
    }, safe(async ({ draftId, action, reason }: {
        draftId: string; action: 'save' | 'publish'; reason: string
    }) => roster.preview(draftId, action, reason)))

    for (const action of ['save', 'publish'] as const) {
        server.registerTool(`attendance_roster_${action}`, {
            description: action === 'save'
                ? 'Guarda en ZincApp un borrador revisado para que oficina lo pueda recuperar. Solicita confirmación humana.'
                : 'Publica una revisión de cuadrante exacta tras la confirmación humana. Si el resultado es incierto usa attendance_roster_operation.',
            inputSchema: { reviewId: id }, annotations: write,
        }, safe(async ({ reviewId }: { reviewId: string }, context) => {
            if (!server.server.getClientCapabilities()?.elicitation?.form) {
                throw new Error('Este cliente MCP no puede solicitar confirmación humana. Completa la revisión desde la CLI de oficina.')
            }
            return roster.apply(reviewId, action, async message => {
                const decision = await server.server.elicitInput({
                    mode: 'form', message,
                    requestedSchema: {
                        type: 'object',
                        properties: { reviewed: { type: 'boolean', title: 'He revisado y confirmo esta operación', default: false } },
                        required: ['reviewed'],
                    },
                }, { timeout: 120_000, signal: context.signal, relatedRequestId: context.requestId })
                return decision.action === 'accept' && decision.content?.reviewed === true
            }, context.signal)
        }))
    }

    server.registerTool('attendance_roster_operation', {
        description: 'Comprueba por UUID el recibo de un intento ya registrado. Esta consulta no puede reenviar la publicación.',
        inputSchema: { requestId: id }, annotations: readOnly,
    }, safe(async ({ requestId }: { requestId: string }) => roster.recover(requestId)))
}
