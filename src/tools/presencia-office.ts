import { execFile } from 'node:child_process'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import type { z } from 'zod'
import { createOfficeDirectory, matchesPrivateOfficeFile, privateOfficeFileSize, shellQuote } from './office-files.js'
import {
    assistedPunch, configuration, configurationChange, correctionChange, correctionInput, day, daysFilters, daySubject,
    employeeId, officeDays, proposalEnvelope, receipt, reportEnvelope, reportFilter, reportReceipt, reportRequest,
    reportReview, reportSummary, reportXlsx, requestId, requestsFilters, requestsPage, resolutionInput, review,
} from './presencia-contract.js'
import type { OfficeRosterConfig } from './roster-office.js'

const execute = promisify(execFile)
const maxBytes = 4 << 20
const maxXlsxBytes = 16 << 20
const xlsxHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04])
export class PresenciaToolError extends Error {}

function cliFlags(values: Record<string, string | number | undefined>) {
    return Object.entries(values).flatMap(([name, value]) => value === undefined ? [] : [`--${name}=${value}`])
}

function comparableChange(change: z.output<typeof correctionChange>) {
    if (!('movement' in change)) return change
    const normalized = { ...change, movement: { ...change.movement, at: Date.parse(change.movement.at) } }
    if (!('exit' in change)) return normalized
    return { ...normalized, exit: { ...change.exit, at: Date.parse(change.exit.at) } }
}

function verifyReportPeriod({ from, until }: z.output<typeof reportFilter>) {
    const elapsedDays = (Date.parse(until) - Date.parse(from)) / 86_400_000
    if (elapsedDays < 0 || elapsedDays > 365) {
        throw new PresenciaToolError('Indica un periodo de hasta 366 días, con la fecha inicial anterior o igual a la final.')
    }
}

function normalizedReportFilter(filter: z.output<typeof reportRequest>['filter'] | z.output<typeof reportReview>['filter']) {
    return { ...filter, employeeIds: [...(filter.employeeIds ?? [])].sort((a, b) => a - b), center: filter.center ?? null }
}

export class OfficePresencia {
    constructor(private readonly config: OfficeRosterConfig) {}

    private async command(args: string[]) {
        const env = { ...process.env }
        delete env.ZINCAPP_AGENT_TOKEN
        try {
            const { stdout } = await execute(this.config.executable, [
                `--profile=${this.config.profile}`, '--json', 'attendance', 'presencia', ...args,
            ], { env, timeout: 45_000, maxBuffer: maxBytes })
            return JSON.parse(stdout) as unknown
        } catch (error) {
            const stderr = (error as { stderr?: unknown }).stderr
            const status = typeof stderr === 'string' && stderr.match(/\bHTTP (4[0-9]{2}|5[0-9]{2})\b/)
            if (status) throw new PresenciaToolError(`La CLI de Presencia devolvió HTTP ${status[1]}.`)
            throw new PresenciaToolError('La CLI de oficina no completó la consulta de Presencia.')
        }
    }

    async getConfiguration(id: number) {
        const employee = employeeId.parse(id)
        const result = configuration.parse(await this.command(['configuration', 'get', `--employee-id=${employee}`]))
        if (result.employeeId !== employee) throw new PresenciaToolError('La configuración corresponde a otra persona.')
        return result
    }

    previewConfiguration(id: number, change: z.input<typeof configurationChange>) {
        const employee = employeeId.parse(id)
        return this.preview('configuration', configurationChange.parse(change), [`--employee-id=${employee}`],
            reviewed => reviewed.kind === 'CONFIGURE' && reviewed.employeeId === employee)
    }

    previewAssist(punch: z.input<typeof assistedPunch>) {
        const input = assistedPunch.parse(punch)
        return this.preview('assist', input, [], reviewed =>
            reviewed.kind === 'ASSISTED_PUNCH' && reviewed.employeeId === input.employeeId &&
            reviewed.proposal.employeeId === input.employeeId)
    }

    async listDays(filters: z.input<typeof daysFilters>) {
        const { date, q, clientId, centerId, view, status, cursor, limit } = daysFilters.parse(filters)
        if ((clientId === undefined) !== (centerId === undefined)) {
            throw new PresenciaToolError('Indica clientId y centerId juntos para filtrar por centro.')
        }
        const result = officeDays.parse(await this.command(['days', 'list', ...cliFlags({
            date, q, 'client-id': clientId, 'center-id': centerId, view, status, cursor, limit,
        })]))
        if (date !== undefined && result.date !== date) {
            throw new PresenciaToolError('El listado de Presencia corresponde a otra fecha.')
        }
        return result
    }

    async getDay(subject: z.input<typeof daySubject>) {
        const { employeeId, date } = daySubject.parse(subject)
        const result = day.parse(await this.command(['days', 'get', ...cliFlags({ 'employee-id': employeeId, date })]))
        if (result.employeeId !== employeeId || result.workDate !== date) {
            throw new PresenciaToolError('La jornada de Presencia corresponde a otra persona o fecha.')
        }
        return result
    }

    async listRequests(filters: z.input<typeof requestsFilters>) {
        const { date, employeeId, status, cursor, limit } = requestsFilters.parse(filters)
        return requestsPage.parse(await this.command(['requests', 'list', ...cliFlags({
            date, 'employee-id': employeeId, status, cursor, limit,
        })]))
    }

    previewCorrection(subject: z.input<typeof daySubject>, correction: z.input<typeof correctionInput>) {
        const { employeeId, date } = daySubject.parse(subject)
        const input = correctionInput.parse(correction)
        return this.preview('correction', input, cliFlags({ 'employee-id': employeeId, date }), reviewed =>
            reviewed.kind === 'CORRECTION' && reviewed.employeeId === employeeId && reviewed.workDate === date &&
            reviewed.revision === input.expectedRevision && reviewed.proposal.expectedRevision === input.expectedRevision &&
            isDeepStrictEqual(comparableChange(reviewed.proposal.change), comparableChange(input.change)))
    }

    previewResolution(id: string, subject: z.input<typeof daySubject>, resolution: z.input<typeof resolutionInput>) {
        const solicitudId = requestId.parse(id)
        const { employeeId, date } = daySubject.parse(subject)
        const input = resolutionInput.parse(resolution)
        return this.preview('resolution', input, cliFlags({ 'solicitud-id': solicitudId, 'employee-id': employeeId, date }), reviewed => {
            if (reviewed.kind !== 'REQUEST_RESOLVE' || reviewed.employeeId !== employeeId ||
                reviewed.workDate !== date || reviewed.revision !== input.expectedRevision ||
                reviewed.proposal.expectedRevision !== input.expectedRevision || reviewed.proposal.solicitudId !== solicitudId) {
                return false
            }
            if (input.decision === 'REJECTED') return reviewed.proposal.decision === 'REJECTED'
            return reviewed.proposal.decision === 'APPROVED' &&
                isDeepStrictEqual(comparableChange(reviewed.proposal.change), comparableChange(input.change))
        })
    }

    private preview(
        group: 'configuration' | 'assist' | 'correction' | 'resolution',
        input: { requestId: string },
        args: string[],
        matches: (reviewed: z.output<typeof review>) => boolean,
    ) {
        return this.stageReview(group, 'apply', input, args, raw => {
            const reviewed = review.parse(raw)
            if (reviewed.requestId !== input.requestId || reviewed.proposal.requestId !== input.requestId || !matches(reviewed)) {
                throw new PresenciaToolError('La revisión de Presencia no coincide con la operación solicitada.')
            }
            return reviewed
        }, (raw, reviewed) => {
            const saved = proposalEnvelope.parse(raw)
            if (!isDeepStrictEqual(saved.review, reviewed)) {
                throw new PresenciaToolError('La propuesta guardada difiere de la revisión de Presencia.')
            }
            const { proof, ...visibleReview } = reviewed
            return { review: visibleReview, identity: saved.identity }
        })
    }

    private async stageReview<Reported, Visible>(
        group: 'configuration' | 'assist' | 'correction' | 'resolution' | 'report',
        confirmVerb: 'apply' | 'export',
        input: { requestId: string },
        args: string[],
        readReview: (raw: unknown) => Reported,
        readProposal: (raw: unknown, reviewed: Reported) => { review: Visible; identity: z.output<typeof proposalEnvelope>['identity'] },
    ) {
        const directory = await createOfficeDirectory(this.config.stateDir, 'review-')
        if (!directory) {
            throw new PresenciaToolError('El directorio de propuestas de Presencia debe ser privado y pertenecer al usuario del MCP.')
        }

        const inputPath = join(directory, 'input.json')
        const proposalPath = join(directory, 'proposal.json')
        try {
            await writeFile(inputPath, JSON.stringify(input), { mode: 0o600, flag: 'wx' })
            const reviewed = readReview(await this.command([
                group, 'preview', ...args, `--input=${inputPath}`, `--output=${proposalPath}`,
            ]))
            if (await privateOfficeFileSize(proposalPath, maxBytes) === undefined) {
                throw new PresenciaToolError('La CLI no guardó una propuesta privada de Presencia.')
            }
            const checked = readProposal(JSON.parse(await readFile(proposalPath, 'utf8')), reviewed)
            await unlink(inputPath)
            const { companyId, cif, userName } = checked.identity
            const terminalCommand = [
                shellQuote(this.config.executable), `--profile=${shellQuote(this.config.profile)}`,
                'attendance', 'presencia', group, confirmVerb, `--proposal=${shellQuote(proposalPath)}`,
            ].join(' ')
            return { review: checked.review, identity: { companyId, cif, userName }, proposalPath, terminalCommand }
        } catch (error) {
            await rm(directory, { recursive: true })
            throw error
        }
    }

    async recover(id: string) {
        const uuid = requestId.parse(id)
        const result = receipt.parse(await this.command(['operation', 'get', `--request-id=${uuid}`]))
        if (result.requestId !== uuid) throw new PresenciaToolError('El recibo corresponde a otra operación de Presencia.')
        return result
    }

    async report(filters: z.input<typeof reportFilter>) {
        const scope = reportFilter.parse(filters)
        verifyReportPeriod(scope)
        const selected = new Set(scope.employeeIds)
        const result = reportSummary.parse(await this.command([
            'report', 'summary', ...cliFlags({ from: scope.from, until: scope.until }),
            ...[...selected].map(id => `--employee-id=${id}`),
            ...cliFlags({ 'client-id': scope.center?.clientId, 'center-id': scope.center?.centerId }),
        ]))
        if (result.from !== scope.from || result.until !== scope.until ||
            (selected.size > 0 && result.rows.some(row => !selected.has(row.employeeId)))) {
            throw new PresenciaToolError('El informe de Presencia no coincide con el ámbito solicitado.')
        }
        return result
    }

    previewReport(raw: z.input<typeof reportRequest>) {
        const input = reportRequest.parse(raw)
        verifyReportPeriod(input.filter)
        const scope = normalizedReportFilter(input.filter)
        return this.stageReview('report', 'export', input, [], output => {
            const reviewed = reportReview.parse(output)
            if (reviewed.requestId !== input.requestId || !isDeepStrictEqual(normalizedReportFilter(reviewed.filter), scope) ||
                (scope.employeeIds.length > 0 && reviewed.employeeCount > scope.employeeIds.length)) {
                throw new PresenciaToolError('La revisión del informe de Presencia no coincide con el ámbito solicitado.')
            }
            return reviewed
        }, (output, reviewed) => {
            const saved = reportEnvelope.parse(output)
            const { proof, ...visible } = saved.review
            if (!isDeepStrictEqual(visible, reviewed)) {
                throw new PresenciaToolError('La propuesta guardada difiere de la revisión del informe de Presencia.')
            }
            return { review: reviewed, identity: saved.identity }
        })
    }

    async reportOperation(id: string) {
        const uuid = requestId.parse(id)
        const result = reportReceipt.parse(await this.command(['report', 'operation', `--request-id=${uuid}`]))
        if (result.requestId !== uuid) throw new PresenciaToolError('El recibo corresponde a otra exportación de Presencia.')
        return result
    }

    async reportXlsx(id: string) {
        const uuid = requestId.parse(id)
        const directory = await createOfficeDirectory(this.config.stateDir, 'xlsx-')
        if (!directory) throw new PresenciaToolError('El directorio de informes de Presencia debe ser privado y pertenecer al usuario del MCP.')

        const stagingPath = join(directory, 'report.xlsx')
        try {
            const result = reportXlsx.parse(await this.command(['report', 'xlsx', `--request-id=${uuid}`, `--output=${stagingPath}`]))
            if (result.requestId !== uuid || !await matchesPrivateOfficeFile(stagingPath, maxXlsxBytes, result.bytes, xlsxHeader)) {
                throw new PresenciaToolError('La CLI no guardó el XLSX privado de la operación solicitada.')
            }
            const xlsxPath = join(directory, result.filename)
            await rename(stagingPath, xlsxPath)
            return { ...result, xlsxPath }
        } catch (error) {
            await rm(directory, { recursive: true })
            throw error
        }
    }
}
