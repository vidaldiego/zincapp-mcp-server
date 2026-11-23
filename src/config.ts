import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { rosterConfigFromEnv, type OfficeRosterConfig } from './tools/roster-office.js'

export interface McpConfig {
    agentToken: string
    apiBaseUrl: string
    locale: string
    roster?: OfficeRosterConfig
}

/**
 * Loads config from environment variables, then falls back to .zincapp.json
 * in the current directory or home directory.
 */
export function loadConfig(): McpConfig {
    const roster = rosterConfigFromEnv(process.env)
    // Environment variables take precedence
    let agentToken = process.env.ZINCAPP_AGENT_TOKEN || ''
    let apiBaseUrl = process.env.ZINCAPP_API_URL || ''
    let locale = process.env.ZINCAPP_LOCALE || ''

    // In office-only mode, require an explicit token to also register the agent tools.
    if (!agentToken && !roster) {
        const configPaths = [
            path.join(process.cwd(), '.zincapp.json'),
            path.join(os.homedir(), '.zincapp.json'),
        ]

        for (const configPath of configPaths) {
            try {
                const raw = fs.readFileSync(configPath, 'utf-8')
                const parsed = JSON.parse(raw)
                if (!agentToken && parsed.agentToken) agentToken = parsed.agentToken
                if (!apiBaseUrl && parsed.apiUrl) apiBaseUrl = parsed.apiUrl
                if (!locale && parsed.locale) locale = parsed.locale
                break
            } catch {
                // File doesn't exist or invalid JSON — continue
            }
        }
    }

    if (!agentToken && !roster) {
        throw new Error(
            'ZINCAPP_AGENT_TOKEN not set. Configure via environment variable or .zincapp.json file.\n' +
            'Create a token at: https://developers.zincapp.com/agent-tokens'
        )
    }

    return {
        agentToken,
        // api.zincapp.com serves the API at the root (agent/v1/…), NOT under /api — that prefix
        // belongs to the my.zincapp.com portal gateway. Override with ZINCAPP_API_URL if needed.
        apiBaseUrl: apiBaseUrl || 'https://api.zincapp.com',
        locale: locale || 'en',
        roster,
    }
}
