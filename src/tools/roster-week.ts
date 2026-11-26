import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { requestId } from './presencia-contract.js'
import { monday, pdfScope, rosterIntent, weekScope } from './roster-week-contract.js'
import { OfficeRosterWeek, RosterWeekToolError } from './roster-week-office.js'

const readOnly = { readOnlyHint: true, openWorldHint: false }
const privateFile = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const preview = z.object({ week: monday, intent: rosterIntent }).strict()
const operation = z.object({ week: monday, requestId }).strict()
const pendingScope = weekScope.extend({ view: z.enum(['draft', 'published']).optional() })

function safe<T>(handler: (input: T) => Promise<unknown>) {
    return async (input: T) => {
        try {
            return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(input), null, 2) }] }
        } catch (error) {
            const message = error instanceof RosterWeekToolError ? error.message :
                'No se pudo verificar la respuesta de cuadrante.'
            return { isError: true, content: [{ type: 'text' as const, text: message }] }
        }
    }
}

export function registerOfficeRosterWeek(server: McpServer, roster: OfficeRosterWeek) {
    for (const [name, verb, description] of [
        ['get', 'show', 'Consulta el cuadrante de lunes a domingo con borrador, revisión publicada y restricciones. Usa nextAfterEmployeeId como afterEmployeeId para consultar otra página.'],
        ['people', 'people', 'Lista personal vigente autorizado para la semana. Puedes buscar por nombre o indicar IDs de empleados.'],
        ['shifts', 'shifts', 'Lista los turnos autorizados para la semana e identifica cada uno por su ID exacto.'],
    ] as const) {
        server.registerTool(`attendance_roster_week_${name}`, {
            description, inputSchema: weekScope, annotations: readOnly,
        }, safe((scope: z.output<typeof weekScope>) => roster.week(verb, scope)))
    }

    server.registerTool('attendance_roster_week_pending', {
        description: 'Lista las fechas pendientes de la semana por persona. Puedes consultar el borrador o la revisión publicada.',
        inputSchema: pendingScope, annotations: readOnly,
    }, safe(({ view, ...scope }: z.output<typeof pendingScope>) => roster.week('pending', scope, view)))

    server.registerTool('attendance_roster_week_preview', {
        description: 'Revisa guardar un borrador o publicar celdas concretas. Indica el UUID, las revisiones actuales y una lista explícita de personas y fechas con SHIFT, REST, PENDING, DRAFT o COPY. Sábado puede quedar PENDING. Da a la persona terminalCommand para revisar y confirmar en su CLI interactiva. Si hay bloqueos, solicita una nueva revisión.',
        inputSchema: preview, annotations: privateFile,
    }, safe((data: z.output<typeof preview>) => roster.preview(data.week, data.intent)))

    server.registerTool('attendance_roster_week_operation', {
        description: 'Consulta por semana y UUID el resultado de una operación de cuadrante. Usa esta consulta tras un resultado incierto.',
        inputSchema: operation, annotations: readOnly,
    }, safe((data: z.output<typeof operation>) => roster.recover(data.week, data.requestId)))

    server.registerTool('attendance_roster_week_pdf', {
        description: 'Descarga un PDF de una revisión publicada concreta, con el ámbito de oficina vigente. Devuelve la ruta del archivo local privado.',
        inputSchema: pdfScope, annotations: privateFile,
    }, safe((data: z.output<typeof pdfScope>) => roster.pdf(data)))
}
