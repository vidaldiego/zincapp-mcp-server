import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import type { z } from 'zod'
import {
    assistedPunch, configuration, configurationChange, correctionChange, correctionInput, day, daysFilters, daySubject,
    employeeId, officeDays, proposalEnvelope, receipt, requestId, requestsFilters, requestsPage, resolutionInput, review,
} from './presencia-contract.js'
import type { OfficeRosterConfig } from './roster-office.js'

const execute = promisify(execFile)
const maxBytes = 4 << 20
export class PresenciaToolError extends Error {}

function shellQuote(value: string) {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

function ownedByProcess(info: { uid: number }) {
    return !process.getuid || info.uid === process.getuid()
}

function cliFlags(values: Record<string, string | number | undefined>) {
    return Object.entries(values).flatMap(([name, value]) => value === undefined ? [] : [`--${name}=${value}`])
}

function comparableChange(change: z.output<typeof correctionChange>) {
    if (!('movement' in change)) return change
    return { ...change, movement: { ...change.movement, at: Date.parse(change.movement.at) } }
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

    private async preview(
        group: 'configuration' | 'assist' | 'correction' | 'resolution',
        input: { requestId: string },
        args: string[],
        matches: (reviewed: z.output<typeof review>) => boolean,
    ) {
        await mkdir(this.config.stateDir, { mode: 0o700, recursive: true })
        const state = await lstat(this.config.stateDir)
        if (!state.isDirectory() || !ownedByProcess(state) || (state.mode & 0o077) !== 0) {
            throw new PresenciaToolError('El directorio de propuestas de Presencia debe ser privado y pertenecer al usuario del MCP.')
        }

        const directory = await mkdtemp(join(this.config.stateDir, 'review-'))
        const inputPath = join(directory, 'input.json')
        const proposalPath = join(directory, 'proposal.json')
        try {
            await writeFile(inputPath, JSON.stringify(input), { mode: 0o600, flag: 'wx' })
            const reviewed = review.parse(await this.command([
                group, 'preview', ...args, `--input=${inputPath}`, `--output=${proposalPath}`,
            ]))
            if (reviewed.requestId !== input.requestId || reviewed.proposal.requestId !== input.requestId || !matches(reviewed)) {
                throw new PresenciaToolError('La revisión de Presencia no coincide con la operación solicitada.')
            }
            const info = await lstat(proposalPath)
            if (!info.isFile() || !ownedByProcess(info) || (info.mode & 0o777) !== 0o600 || info.size > maxBytes) {
                throw new PresenciaToolError('La CLI no guardó una propuesta privada de Presencia.')
            }
            const saved = proposalEnvelope.parse(JSON.parse(await readFile(proposalPath, 'utf8')))
            if (!isDeepStrictEqual(saved.review, reviewed)) {
                throw new PresenciaToolError('La propuesta guardada difiere de la revisión de Presencia.')
            }
            await unlink(inputPath)
            const { proof, ...visibleReview } = reviewed
            const { companyId, cif, userName } = saved.identity
            const terminalCommand = [
                shellQuote(this.config.executable), `--profile=${shellQuote(this.config.profile)}`,
                'attendance', 'presencia', group, 'apply', `--proposal=${shellQuote(proposalPath)}`,
            ].join(' ')
            return { review: visibleReview, identity: { companyId, cif, userName }, proposalPath, terminalCommand }
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
}
