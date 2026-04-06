import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export interface McpConfig {
    agentToken: string
    apiBaseUrl: string
}

/**
 * Loads config from environment variables, then falls back to .zincapp.json
 * in the current directory or home directory.
 */
export function loadConfig(): McpConfig {
    // Environment variables take precedence
    let agentToken = process.env.ZINCAPP_AGENT_TOKEN || ''
    let apiBaseUrl = process.env.ZINCAPP_API_URL || ''

    // Try .zincapp.json if env vars missing
    if (!agentToken) {
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
                break
            } catch {
                // File doesn't exist or invalid JSON — continue
            }
        }
    }

    if (!agentToken) {
        throw new Error(
            'ZINCAPP_AGENT_TOKEN not set. Configure via environment variable or .zincapp.json file.\n' +
            'Create a token at: https://developers.zincapp.com/agent-tokens'
        )
    }

    return {
        agentToken,
        apiBaseUrl: apiBaseUrl || 'https://api.zincapp.com/api',
    }
}
