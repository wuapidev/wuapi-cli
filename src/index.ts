// Programmatic entry: the path and credential helpers the MCP server mirrors,
// and `main` to run the CLI in-process.
export { configDir, credentialsPath, pendingLoginPath } from "./paths.js";
export { loadCredentials, saveCredentials, defaultProfileName, slug, type Credentials, type Profile } from "./credentials.js";
export { main } from "./main.js";
export type { Io } from "./io.js";
export { OPERATIONS } from "./generated/operations.js";
export type { Operation, OperationField } from "./operation.js";
export { VERSION } from "./version.js";
