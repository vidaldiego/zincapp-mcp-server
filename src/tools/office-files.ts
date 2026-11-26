import { lstat, mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'

function ownedByProcess(info: { uid: number }) {
    return !process.getuid || info.uid === process.getuid()
}

export function shellQuote(value: string) {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

export async function createOfficeDirectory(stateDir: string, prefix: string) {
    await mkdir(stateDir, { mode: 0o700, recursive: true })
    const info = await lstat(stateDir)
    if (!info.isDirectory() || !ownedByProcess(info) || (info.mode & 0o077) !== 0) return undefined
    return mkdtemp(join(stateDir, prefix))
}

export async function privateOfficeFileSize(path: string, maxSize: number) {
    const info = await lstat(path)
    if (!info.isFile() || !ownedByProcess(info) || (info.mode & 0o777) !== 0o600 || info.size > maxSize) {
        return undefined
    }
    return info.size
}
