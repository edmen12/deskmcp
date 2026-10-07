/**
 * Docker MCP Gateway prompt utilities
 * Handles detection and messaging for users using Docker MCP Gateway
 */
/**
 * Check if user should be prompted about Docker MCP Gateway
 */
export declare function shouldPromptForDockerInfo(): Promise<boolean>;
/**
 * Get Docker environment information message for LLM injection
 */
export declare function getDockerInfoMessage(): string;
/**
 * Process Docker prompt injection for successful tool calls
 * Returns the modified result with Docker message injected if conditions are met
 */
export declare function processDockerPrompt(result: any, toolName: string): Promise<any>;
