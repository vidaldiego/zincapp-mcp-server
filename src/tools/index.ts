import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { registerSearchDocs } from './search-docs.js'
import { registerReadDoc } from './read-doc.js'
import { registerListDocs } from './list-docs.js'
import { registerListEndpoints } from './list-endpoints.js'
import { registerGetEndpoint } from './get-endpoint.js'
import { registerSandboxRequest } from './sandbox-request.js'
import { registerGetContract } from './get-contract.js'

export function registerAllTools(server: McpServer, client: ZincAppClient) {
    registerSearchDocs(server, client)
    registerReadDoc(server, client)
    registerListDocs(server, client)
    registerListEndpoints(server, client)
    registerGetEndpoint(server, client)
    registerSandboxRequest(server, client)
    registerGetContract(server, client)
}
