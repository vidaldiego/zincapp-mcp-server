import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
    assistedPunch, configurationChange, employeeId, OfficePresencia, PresenciaToolError, requestId,
} from './presencia-office.js'

const readOnly = { readOnlyHint: true, openWorldHint: false }
const privateReview = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

function safe<T>(handler: (input: T) => Promise<unknown>) {
    return async (input: T) => {
        try {
            return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(input), null, 2) }] }
        } catch (error) {
            const message = error instanceof PresenciaToolError ? error.message :
                'No se pudo verificar la respuesta de Presencia.'
            return { isError: true, content: [{ type: 'text' as const, text: message }] }
        }
    }
}

export function registerOfficePresencia(server: McpServer, presencia: OfficePresencia) {
    server.registerTool('attendance_presencia_configuration_get', {
        description: 'Consulta la configuración de Presencia de un empleado (ID explícito) con el perfil de oficina fijado.',
        inputSchema: z.object({ employeeId }).strict(), annotations: readOnly,
    }, safe(async ({ employeeId }: { employeeId: number }) => presencia.getConfiguration(employeeId)))

    server.registerTool('attendance_presencia_configuration_preview', {
        description: 'Revisa un cambio de configuración de Presencia. Entrega una propuesta privada para que la persona revise y confirme en la CLI interactiva.',
        inputSchema: z.object({ employeeId, change: configurationChange }).strict(), annotations: privateReview,
    }, safe(async ({ employeeId, change }: { employeeId: number; change: z.output<typeof configurationChange> }) =>
        presencia.previewConfiguration(employeeId, change)))

    server.registerTool('attendance_presencia_assist_preview', {
        description: 'Revisa un fichaje asistido con persona, acción, lugar y motivo explícitos. Entrega una propuesta privada para confirmación en la CLI interactiva. La hora la fija el servidor al aplicar.',
        inputSchema: z.object({ punch: assistedPunch }).strict(), annotations: privateReview,
    }, safe(async ({ punch }: { punch: z.output<typeof assistedPunch> }) => presencia.previewAssist(punch)))

    server.registerTool('attendance_presencia_operation', {
        description: 'Comprueba por UUID el resultado de una operación de Presencia. NOT_OBSERVED indica que aún no consta resultado. La consulta no reenvía el intento.',
        inputSchema: z.object({ requestId }).strict(), annotations: readOnly,
    }, safe(async ({ requestId }: { requestId: string }) => presencia.recover(requestId)))
}
