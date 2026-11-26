import { execFile } from 'node:child_process'
import { open, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import type { z } from 'zod'
import { createOfficeDirectory, privateOfficeFileSize, shellQuote } from './office-files.js'
import { requestId } from './presencia-contract.js'
import type { OfficeRosterConfig } from './roster-office.js'
import {
    monday, pdfMetadata, pdfScope, rosterEnvelope, rosterIntent, rosterPending, rosterPeople,
    rosterReceipt, rosterReview, rosterShifts, rosterWeek, weekScope,
} from './roster-week-contract.js'

const execute = promisify(execFile)
const maxJsonBytes = 4 << 20
const maxPdfBytes = 8 << 20
export class RosterWeekToolError extends Error {}

function employeeFlags(ids?: number[]) {
    return (ids ?? []).map(id => `--employee-id=${id}`)
}

function cellKey(cell: { employeeId: number; date: string }) {
    return `${cell.employeeId}/${cell.date}`
}

function weekDate(monday: string, offset: number) {
    return new Date(Date.parse(monday) + offset * 86_400_000).toISOString().slice(0, 10)
}

function validateIntent(week: string, intent: z.output<typeof rosterIntent>) {
    const selected = new Set(intent.cells.map(cellKey))
    const end = weekDate(week, 6)
    if (selected.size !== intent.cells.length || intent.cells.some(({ date }) => date < week || date > end)) {
        throw new RosterWeekToolError('Indica cada pareja persona y fecha una sola vez y dentro de la semana.')
    }
    const copying = intent.cells.some(cell => cell.choice === 'COPY')
    if (copying !== (intent.copyFromMonday !== undefined) || intent.copyFromMonday && intent.copyFromMonday >= week) {
        throw new RosterWeekToolError('Para copiar, indica un lunes publicado anterior y las celdas exactas del destino.')
    }
    if (intent.action === 'SAVE_DRAFT' && intent.cells.some(cell => cell.choice === 'DRAFT')) {
        throw new RosterWeekToolError('Elige DRAFT para publicar cambios que ya están en el borrador.')
    }
    return selected
}

export class OfficeRosterWeek {
    constructor(private readonly config: OfficeRosterConfig) {}

    private async command(args: string[]) {
        const env = { ...process.env }
        delete env.ZINCAPP_AGENT_TOKEN
        try {
            const { stdout } = await execute(this.config.executable, [
                `--profile=${this.config.profile}`, '--json', 'attendance', 'roster', 'week', ...args,
            ], { env, timeout: 45_000, maxBuffer: maxJsonBytes })
            return JSON.parse(stdout) as unknown
        } catch (error) {
            const stderr = (error as { stderr?: unknown }).stderr
            const status = typeof stderr === 'string' && stderr.match(/\bHTTP (4[0-9]{2}|5[0-9]{2})\b/)
            if (status) throw new RosterWeekToolError(`La CLI de cuadrantes devolvió HTTP ${status[1]}.`)
            throw new RosterWeekToolError('La CLI de oficina no completó la consulta de cuadrante.')
        }
    }

    async week(verb: 'show' | 'people' | 'shifts' | 'pending', input: z.input<typeof weekScope>, view?: 'draft' | 'published') {
        const scope = weekScope.parse(input)
        const args = [verb, `--week=${scope.week}`, ...employeeFlags(scope.employeeIds)]
        if (scope.search !== undefined) args.push(`--search=${scope.search}`)
        if (scope.afterEmployeeId !== undefined) args.push(`--after-employee-id=${scope.afterEmployeeId}`)
        if (scope.limit !== undefined) args.push(`--limit=${scope.limit}`)
        if (view !== undefined) args.push(`--view=${view}`)
        const result = await this.command(args)
        switch (verb) {
            case 'people': return rosterPeople.parse(result)
            case 'shifts': return rosterShifts.parse(result)
            case 'pending': return rosterPending.parse(result)
            case 'show': {
                const week = rosterWeek.parse(result)
                if (week.monday !== scope.week) throw new RosterWeekToolError('El cuadrante corresponde a otra semana.')
                return week
            }
        }
    }

    async preview(week: string, raw: z.input<typeof rosterIntent>) {
        const selectedWeek = monday.parse(week)
        const intent = rosterIntent.parse(raw)
        const selected = validateIntent(selectedWeek, intent)
        const employees = new Set(intent.cells.map(cell => cell.employeeId))
        const friday = weekDate(selectedWeek, 4)
        const directory = await this.artifactDirectory('review-')
        const inputPath = join(directory, 'input.json')
        const proposalPath = join(directory, 'proposal.json')
        let retained = false
        try {
            await writeFile(inputPath, JSON.stringify(intent), { mode: 0o600, flag: 'wx' })
            const reviewed = rosterReview.parse(await this.command([
                'preview', `--week=${selectedWeek}`, `--input=${inputPath}`, `--output=${proposalPath}`,
            ]))
            if (reviewed.monday !== selectedWeek || reviewed.requestId !== intent.requestId ||
                reviewed.action !== intent.action || reviewed.draftRevision !== intent.draftRevision ||
                (reviewed.publishedRevision ?? null) !== intent.publishedRevision ||
                reviewed.changes.some(change => !selected.has(cellKey(change))) ||
                reviewed.blockers.some(blocker => !selected.has(cellKey(blocker)) && !(
                    intent.action === 'PUBLISH' && blocker.code === 'PRESENCIA_ROSTER_PENDING_WEEKDAY' &&
                    employees.has(blocker.employeeId) && blocker.date >= selectedWeek && blocker.date <= friday
                ))) {
                throw new RosterWeekToolError('La revisión de cuadrante no coincide con la operación solicitada.')
            }
            if (reviewed.blockers.length) return { review: reviewed }
            if (!reviewed.expiresAt || !await privateOfficeFileSize(proposalPath, maxJsonBytes)) {
                throw new RosterWeekToolError('La CLI no guardó una propuesta privada de cuadrante.')
            }
            const saved = rosterEnvelope.parse(JSON.parse(await readFile(proposalPath, 'utf8')))
            const { proof, ...savedReview } = saved.review
            if (!isDeepStrictEqual(savedReview, reviewed) || !isDeepStrictEqual(saved.intent, intent)) {
                throw new RosterWeekToolError('La propuesta guardada difiere de la revisión de cuadrante.')
            }

            await unlink(inputPath)
            const { companyId, cif, userName } = saved.identity
            const terminalCommand = [
                shellQuote(this.config.executable), `--profile=${shellQuote(this.config.profile)}`, 'attendance', 'roster', 'week',
                intent.action === 'PUBLISH' ? 'publish' : 'save', `--proposal=${shellQuote(proposalPath)}`,
            ].join(' ')
            retained = true
            return { review: reviewed, identity: { companyId, cif, userName }, proposalPath, terminalCommand }
        } finally {
            if (!retained) await rm(directory, { recursive: true })
        }
    }

    async recover(week: string, id: string) {
        const selectedWeek = monday.parse(week)
        const selectedId = requestId.parse(id)
        const result = rosterReceipt.parse(await this.command(['operation', `--week=${selectedWeek}`, `--request-id=${selectedId}`]))
        if (result.monday !== selectedWeek || result.requestId !== selectedId) {
            throw new RosterWeekToolError('El recibo corresponde a otra operación de cuadrante.')
        }
        return result
    }

    async pdf(input: z.input<typeof pdfScope>) {
        const { week, revision, employeeIds } = pdfScope.parse(input)
        const directory = await this.artifactDirectory('pdf-')
        const filename = `cuadrante-${week}-r${revision}.pdf`
        const pdfPath = join(directory, filename)
        let retained = false
        try {
            const result = pdfMetadata.parse(await this.command([
                'pdf', `--week=${week}`, `--revision=${revision}`, `--output=${pdfPath}`, ...employeeFlags(employeeIds),
            ]))
            if (result.monday !== week || result.revision !== revision || result.filename !== filename ||
                !await matchesPdf(pdfPath, result.bytes)) {
                throw new RosterWeekToolError('El PDF privado no corresponde a la revisión solicitada.')
            }
            retained = true
            return { ...result, pdfPath }
        } finally {
            if (!retained) await rm(directory, { recursive: true })
        }
    }

    private async artifactDirectory(prefix: string) {
        const directory = await createOfficeDirectory(this.config.stateDir, prefix)
        if (!directory) throw new RosterWeekToolError('El directorio de cuadrantes debe ser privado y pertenecer al usuario del MCP.')
        return directory
    }
}

async function matchesPdf(path: string, size: number) {
    if (await privateOfficeFileSize(path, maxPdfBytes) !== size) return false
    const file = await open(path, 'r')
    try {
        const header = Buffer.alloc(5)
        const result = await file.read(header, 0, header.byteLength, 0)
        return result.bytesRead === header.byteLength && header.toString('ascii') === '%PDF-'
    } finally {
        await file.close()
    }
}
