import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZincAppClient } from '../client.js'
import { registerSearchDocs } from './search-docs.js'
import { registerReadDoc } from './read-doc.js'
import { registerListDocs } from './list-docs.js'
import { registerListEndpoints } from './list-endpoints.js'
import { registerGetEndpoint } from './get-endpoint.js'
import { registerSandboxRequest } from './sandbox-request.js'
import { registerGetContract } from './get-contract.js'
import { registerAuditRetiradas } from './audit-retiradas.js'
import { registerListRetiradas } from './list-retiradas.js'
import { registerGetRetiradaAudit } from './get-retirada-audit.js'
import { registerProposeCompletion } from './propose-completion.js'
import { registerAuditEntities } from './audit-entities.js'
import { registerApplyCompletion } from './apply-completion.js'
import { registerProposeAuthorizations } from './propose-authorizations.js'
import { registerApplyAuthorization } from './apply-authorization.js'
import { registerLinkGestorAuthorizations } from './link-gestor-authorizations.js'
import { registerProposeNt } from './propose-nt.js'
import { registerLookupAuthorization } from './lookup-authorization.js'
import { registerNtFinalGestor } from './nt-final-gestor.js'

export function registerAllTools(server: McpServer, client: ZincAppClient) {
    registerSearchDocs(server, client)
    registerReadDoc(server, client)
    registerListDocs(server, client)
    registerListEndpoints(server, client)
    registerGetEndpoint(server, client)
    registerSandboxRequest(server, client)
    registerGetContract(server, client)
    registerAuditRetiradas(server, client)
    registerListRetiradas(server, client)
    registerGetRetiradaAudit(server, client)
    registerProposeCompletion(server, client)
    registerAuditEntities(server, client)
    registerApplyCompletion(server, client)
    registerProposeAuthorizations(server, client)
    registerApplyAuthorization(server, client)
    registerLinkGestorAuthorizations(server, client)
    registerProposeNt(server, client)
    registerLookupAuthorization(server, client)
    registerNtFinalGestor(server, client)
}
