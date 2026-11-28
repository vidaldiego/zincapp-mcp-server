import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
    archiveFilter, archiveOriginalInput, archiveSubject, assistedPunch, configurationChange, correctionInput, daysFilters, daySubject,
    employeeId, reportFilter, reportRequest, requestId, requestsFilters, resolutionInput,
} from './presencia-contract.js'
import { OfficePresencia, PresenciaToolError } from './presencia-office.js'

const readOnly = { readOnlyHint: true, openWorldHint: false }
const privateReview = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const correctionPreview = daySubject.extend({ correction: correctionInput })
const resolutionPreview = daySubject.extend({ solicitudId: requestId, resolution: resolutionInput })

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
    server.registerTool('attendance_presencia_archive_list', {
        description: 'Lista jornadas históricas de un empleado dentro de un periodo inclusivo. Usa nextCursor con el mismo empleado y fechas para pedir otra página.',
        inputSchema: archiveFilter, annotations: readOnly,
    }, safe((input: z.output<typeof archiveFilter>) => presencia.listArchive(input)))

    server.registerTool('attendance_presencia_archive_day', {
        description: 'Consulta una jornada histórica exacta: movimientos y resumen del registro clásico o listado de los originales firmados.',
        inputSchema: archiveSubject, annotations: readOnly,
    }, safe((input: z.output<typeof archiveSubject>) => presencia.getArchiveDay(input)))

    server.registerTool('attendance_presencia_archive_original', {
        description: 'Descarga un recibo o decisión firmados de una jornada histórica con los permisos vigentes de oficina. Devuelve metadatos y la ruta del archivo local privado.',
        inputSchema: archiveOriginalInput, annotations: privateReview,
    }, safe((input: z.output<typeof archiveOriginalInput>) => presencia.downloadArchiveOriginal(input)))

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

    server.registerTool('attendance_presencia_days_list', {
        description: 'Lista jornadas de Presencia y el total por estado con los mismos filtros. Sin fecha usa hoy en la zona de la empresa. Usa clientId y centerId juntos para el centro administrativo y nextCursor para pedir otra página.',
        inputSchema: daysFilters, annotations: readOnly,
    }, safe((filters: z.output<typeof daysFilters>) => presencia.listDays(filters)))

    server.registerTool('attendance_presencia_days_get', {
        description: 'Consulta la jornada de una persona en una fecha lógica ISO. Incluye horario, movimientos originales y efectivos, etiquetas de centros, correcciones, solicitudes, totales y permisos.',
        inputSchema: daySubject, annotations: readOnly,
    }, safe((subject: z.output<typeof daySubject>) => presencia.getDay(subject)))

    server.registerTool('attendance_presencia_requests_list', {
        description: 'Consulta las solicitudes de ajuste de Presencia en el ámbito de oficina por fecha, persona o estado. Usa nextCursor para pedir otra página.',
        inputSchema: requestsFilters, annotations: readOnly,
    }, safe((filters: z.output<typeof requestsFilters>) => presencia.listRequests(filters)))

    server.registerTool('attendance_presencia_correction_preview', {
        description: 'Revisa una corrección ADD, REPLACE, VOID o REVERT en una jornada exacta. Para una jornada omitida, ADD admite movement con ENTRY y exit con EXIT. Indica los dos instantes en UTC y sus lugares. La propuesta privada se confirma en la CLI interactiva.',
        inputSchema: correctionPreview, annotations: privateReview,
    }, safe(({ correction, ...subject }: z.output<typeof correctionPreview>) => presencia.previewCorrection(subject, correction)))

    server.registerTool('attendance_presencia_resolution_preview', {
        description: 'Revisa la aprobación o rechazo de una solicitud de Presencia. Indica solicitudId, empleado, fecha, un UUID de operación y la revisión de la jornada. Para aprobar, incluye el cambio auditado. La propuesta privada se confirma en la CLI interactiva.',
        inputSchema: resolutionPreview, annotations: privateReview,
    }, safe(({ solicitudId, resolution, ...subject }: z.output<typeof resolutionPreview>) =>
        presencia.previewResolution(solicitudId, subject, resolution)))

    server.registerTool('attendance_presencia_operation', {
        description: 'Comprueba por UUID el resultado de una operación de Presencia. NOT_OBSERVED indica que aún no consta resultado. La consulta no reenvía el intento.',
        inputSchema: z.object({ requestId }).strict(), annotations: readOnly,
    }, safe(async ({ requestId }: { requestId: string }) => presencia.recover(requestId)))

    server.registerTool('attendance_presencia_report_summary', {
        description: 'Consulta el resumen de Presencia y sus totales para un periodo inclusivo de hasta 366 días en la zona de la empresa. Puedes indicar empleados y un centro para limitar el ámbito.',
        inputSchema: reportFilter, annotations: readOnly,
    }, safe((filter: z.output<typeof reportFilter>) => presencia.report(filter)))

    server.registerTool('attendance_presencia_export_preview', {
        description: 'Prepara una revisión de exportación XLSX con el UUID, las fechas y el ámbito exactos. Entrega la propuesta privada y el comando para confirmar la huella en la CLI interactiva.',
        inputSchema: reportRequest, annotations: privateReview,
    }, safe((input: z.output<typeof reportRequest>) => presencia.previewReport(input)))

    server.registerTool('attendance_presencia_export_operation', {
        description: 'Consulta una vez el estado de la exportación XLSX por su UUID. Solicita otra consulta sólo cuando la persona lo indique.',
        inputSchema: z.object({ requestId }).strict(), annotations: readOnly,
    }, safe(({ requestId }: { requestId: string }) => presencia.reportOperation(requestId)))

    server.registerTool('attendance_presencia_export_xlsx', {
        description: 'Descarga el XLSX de un UUID ya disponible con el perfil de oficina vigente. Devuelve la ruta de un archivo local privado.',
        inputSchema: z.object({ requestId }).strict(), annotations: privateReview,
    }, safe(({ requestId }: { requestId: string }) => presencia.reportXlsx(requestId)))
}
