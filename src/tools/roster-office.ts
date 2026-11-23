import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

export interface OfficeRosterConfig {
    executable: string
    profile: string
    stateDir: string
}

export function rosterConfigFromEnv(env: NodeJS.ProcessEnv): OfficeRosterConfig | undefined {
    const executable = env.ZINCAPP_ROSTER_CLI
    const profile = env.ZINCAPP_ROSTER_PROFILE
    if (!executable && !profile) return undefined
    if (!executable || !isAbsolute(executable) || !profile || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(profile)) {
        throw new Error('Office roster requires an absolute ZINCAPP_ROSTER_CLI and a fixed ZINCAPP_ROSTER_PROFILE.')
    }
    return { executable, profile, stateDir: join(homedir(), '.local', 'state', 'zincapp-mcp', 'office-roster') }
}

const uuid = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const employeeId = z.number().int().min(1).max(2147483647)
const employeeIDs = z.array(employeeId).min(1).max(200)
    .refine(ids => new Set(ids).size === ids.length, 'employee IDs must be unique')
export const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine(days => new Set(days).size === days.length, 'weekdays must be unique')
export const weekInput = z.object({
    week: date,
    employees: employeeIDs,
    cohort: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
    view: z.enum(['draft', 'published']).optional(),
}).strict()
type WeekInput = z.input<typeof weekInput>

export const editInput = z.discriminatedUnion('verb', [
    z.object({ verb: z.literal('assign'), employees: employeeIDs, days: weekdays, version: uuid }).strict(),
    z.object({ verb: z.literal('rest'), employees: employeeIDs, days: weekdays }).strict(),
    z.object({ verb: z.literal('inherit'), employees: employeeIDs, days: weekdays }).strict(),
    z.object({ verb: z.literal('section'), employees: employeeIDs, label: z.string().trim().min(1).max(80).nullable() }).strict(),
])
type EditInput = z.input<typeof editInput>
export const importRows = z.array(z.object({
    employee: employeeId, days: weekdays, decision: z.union([z.enum(['REST', 'INHERIT']), uuid]),
}).strict()).min(1).max(200)
type ImportRows = z.input<typeof importRows>

const dayReview = z.object({
    date, status: z.string(), origin: z.string(), decision: z.string().optional(),
    model: z.object({ versionId: uuid, subject: z.string() }).optional(),
    timezone: z.string().optional(), expectedMinutes: z.number().int().optional(),
    ruleCenter: z.string().optional(), plannedLocation: z.string().optional(), calendarOverride: z.boolean().optional(),
    blocks: z.array(z.object({
        start: z.string(), end: z.string(), endDayOffset: z.number().int(),
        startOffset: z.string().nullable(), endOffset: z.string().nullable(),
    })).optional(),
})

const reviewResult = z.object({
    reviewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    identity: z.object({ companyId: z.number().int().positive(), cif: z.string(), actor: z.string() }),
    command: z.object({
        requestId: uuid, previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
        action: z.enum(['SAVE', 'PUBLISH']), reason: z.string().min(1).max(1000),
        proposal: z.object({
            query: z.object({ monday: date, employeeIds: employeeIDs }),
            cohort: z.string(), effectiveFrom: date, effectiveUntil: date,
        }),
    }),
    review: z.object({
        blockers: z.array(z.unknown()).max(5600),
        changes: z.array(z.object({ employeeId: employeeId, before: dayReview, after: dayReview })).max(1400),
        sections: z.array(z.object({ employeeId: employeeId, before: z.string().nullable(), after: z.string().nullable() })).max(200),
    }),
})
const receipt = z.object({
    requestId: uuid,
    outcome: z.literal('COMMITTED'),
    revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
    resultRef: uuid, kind: z.enum(['ROSTER_SAVE', 'ROSTER_PUBLISH']),
    employeeIds: employeeIDs, effectiveFrom: date, effectiveUntil: date,
})
type Run = (executable: string, args: string[]) => Promise<unknown>
const execute = promisify(execFile)
const runTool: Run = async (executable, args) => {
    const env = { ...process.env }
    delete env.ZINCAPP_AGENT_TOKEN
    try {
        const { stdout } = await execute(executable, args, { env, timeout: 45_000, maxBuffer: 4 << 20 })
        return JSON.parse(stdout)
    } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr
        const recovery = typeof stderr === 'string' && stderr.match(/recover (?:request )?([0-9a-f-]{36})/i)
        if (recovery && uuid.safeParse(recovery[1]).success) {
            throw new Error(`Resultado sin verificar. Comprueba la operación ${recovery[1]} sin volver a publicar.`)
        }
        const status = typeof stderr === 'string' && stderr.match(/\b(401|403|406|409|422|429|503)\b/)
        if (status) throw new Error(`ZincApp rechazó la operación (${status[1]}). Revisa el perfil, los permisos y el borrador.`)
        throw new Error('La CLI de oficina no completó la operación. Consulta el perfil y revisa la propuesta en terminal.')
    }
}

const maxConfirmationBytes = 28_000

function formatDay(day: z.output<typeof dayReview>) {
    const blocks = day.blocks?.map(block => {
        const overnight = block.endDayOffset ? ` (+${block.endDayOffset} día)` : ''
        return `${block.start}${block.startOffset ?? ''}–${block.end}${block.endOffset ?? ''}${overnight}`
    }).join(', ')
    return [
        `${day.status} [${day.origin}]`, day.decision, day.model && `${day.model.subject} ${day.model.versionId}`,
        blocks, day.timezone, day.expectedMinutes === undefined ? undefined : `${day.expectedMinutes} min previstos`,
        day.ruleCenter && `centro de regla ${day.ruleCenter}`, day.plannedLocation && `lugar ${day.plannedLocation}`,
        day.calendarOverride && 'excepción de calendario',
    ].filter(Boolean).join(' · ')
}

function confirmationMessage(reviewed: z.output<typeof reviewResult>) {
    const { identity, command, review } = reviewed
    const proposal = command.proposal
    const lines = [
        `${command.action === 'PUBLISH' ? 'Publicar' : 'Guardar borrador del'} cuadrante de la empresa ${identity.companyId} (${identity.cif}).`,
        `Cuenta ${identity.actor} · Semana ${proposal.query.monday} · Grupo ${proposal.cohort}`,
        `Del ${proposal.effectiveFrom} al ${proposal.effectiveUntil} (día final excluido)`,
        `Personas seleccionadas (ID) ${proposal.query.employeeIds.join(', ')}`,
        `Motivo: ${command.reason}`,
        ...review.changes.map(change => `#${change.employeeId} ${change.after.date}: ${formatDay(change.before)} → ${formatDay(change.after)}`),
        ...review.sections.map(change => `#${change.employeeId} Sección semanal: ${change.before ?? '—'} → ${change.after ?? '—'}`),
        `Operación ${command.requestId}`,
        `Huella de la revisión ${reviewed.reviewFingerprint}`,
    ]
    const message = lines.join('\n')
    if (Buffer.byteLength(message) > maxConfirmationBytes) {
        throw new Error('La propuesta supera el límite de la confirmación MCP. Revisa la propuesta completa desde la CLI de oficina.')
    }
    return message
}

export class OfficeRoster {
    constructor(private readonly config: OfficeRosterConfig, private readonly run: Run = runTool) {}

    private command(verb: string, args: string[]) {
        return this.run(this.config.executable, [`--profile=${this.config.profile}`, '--json', 'attendance', 'roster', verb, ...args])
    }

    private async store(id: string) {
        const key = uuid.parse(id)
        await mkdir(this.config.stateDir, { mode: 0o700, recursive: true })
        const info = await lstat(this.config.stateDir)
        if (!info.isDirectory() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) {
            throw new Error('El directorio de cuadrantes debe ser privado y pertenecer al usuario del MCP.')
        }
        return join(this.config.stateDir, key + '.json')
    }

    people(search: string | undefined, first: number, max: number) {
        return this.command('people', [`--first=${first}`, `--max=${max}`, ...(search === undefined ? [] : [`--search=${search}`])])
    }

    models(week: string, first: number, max: number, days?: number[]) {
        const args = [`--week=${date.parse(week)}`, `--first=${first}`, `--max=${max}`]
        if (days) args.push(`--day=${weekdays.parse(days).join(',')}`)
        return this.command('models', args)
    }

    async week(input: WeekInput, pending: boolean) {
        const scope = weekInput.parse(input)
        const args = [`--week=${scope.week}`, `--employee-id=${scope.employees.join(',')}`, `--view=${scope.view ?? 'draft'}`]
        if (scope.cohort) args.push(`--cohort=${scope.cohort}`)
        return this.command(pending ? 'pending' : 'show', args)
    }

    async inspect(id: string, pending: boolean) {
        return this.command(pending ? 'pending' : 'show', [`--draft=${await this.store(id)}`])
    }

    async init(input: Omit<WeekInput, 'view'>, interval: 'weekdays' | 'saturday' | 'week') {
        const scope = weekInput.parse(input)
        const id = randomUUID()
        const args = [`--week=${scope.week}`, `--employee-id=${scope.employees.join(',')}`, `--interval=${interval}`,
            `--out=${await this.store(id)}`]
        if (scope.cohort) args.push(`--cohort=${scope.cohort}`)
        return { draftId: id, roster: await this.command('init', args) }
    }

    async edit(id: string, raw: EditInput) {
        const edit = editInput.parse(raw)
        const next = randomUUID()
        const args = [`--draft=${await this.store(id)}`, `--out=${await this.store(next)}`, `--employee-id=${edit.employees.join(',')}`]
        if (edit.verb === 'section') args.push(edit.label === null ? '--clear' : `--label=${edit.label}`)
        else {
            args.push(`--day=${edit.days.join(',')}`)
            if (edit.verb === 'assign') args.push(`--model-version=${edit.version}`)
        }
        return { draftId: next, roster: await this.command(edit.verb, args) }
    }

    async copy(id: string, fromWeek: string) {
        const next = randomUUID()
        const args = [`--draft=${await this.store(id)}`, `--out=${await this.store(next)}`, `--from-week=${date.parse(fromWeek)}`]
        return { draftId: next, copy: await this.command('copy', args) }
    }

    async importAssignments(id: string, raw: ImportRows) {
        const rows = importRows.parse(raw)
        const next = randomUUID()
        const args = [`--draft=${await this.store(id)}`, `--out=${await this.store(next)}`]
        for (const row of rows) args.push(`--row=${row.employee};${row.days.join(',')};${row.decision}`)
        return { draftId: next, roster: await this.command('import', args) }
    }

    async preview(id: string, action: 'save' | 'publish', reason: string) {
        const reviewId = randomUUID()
        const input = [`--draft=${await this.store(id)}`, `--out=${await this.store(reviewId)}`, `--action=${action}`, `--reason=${reason}`]
        return { reviewId, ...reviewResult.parse(await this.command('preview', input)) }
    }

    async apply(id: string, action: 'save' | 'publish', confirm: (message: string) => Promise<boolean>, signal?: AbortSignal) {
        signal?.throwIfAborted()
        const path = await this.store(id)
        const args = [`--review=${path}`]
        const reviewed = reviewResult.parse(await this.command(action, [...args, '--dry-run']))
        const { command, review } = reviewed
        if (command.action !== action.toUpperCase() || review.blockers.length) throw new Error('La revisión tiene bloqueos o corresponde a otra acción.')
        signal?.throwIfAborted()
        if (!await confirm(confirmationMessage(reviewed))) throw new Error('La persona usuaria no ha confirmado la revisión.')
        signal?.throwIfAborted()
        const current = reviewResult.parse(await this.command(action, [...args, '--dry-run']))
        if (JSON.stringify(current) !== JSON.stringify(reviewed)) throw new Error('La revisión ha cambiado; prepara y confirma otra propuesta.')
        signal?.throwIfAborted()
        try {
            const result = receipt.parse(await this.command(action, [...args, `--expect-review-sha256=${reviewed.reviewFingerprint}`, '--yes']))
            if (result.requestId !== command.requestId || result.kind !== `ROSTER_${command.action}`) {
                throw new Error('El recibo no coincide con la revisión confirmada.')
            }
            return result
        } catch {
            throw new Error(`Resultado sin verificar. Comprueba la operación ${command.requestId} antes de preparar otra publicación.`)
        }
    }

    async recover(id: string) {
        return receipt.parse(await this.command('operation', [`--request-id=${uuid.parse(id)}`]))
    }
}
