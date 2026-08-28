import { requestShutdown } from './control-server.js';

const rawPort = process.argv[2] ?? process.env.DESKTOP_MCP_PORT ?? '8765';
const port = Number.parseInt(rawPort, 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid DeskMCP port: ${rawPort}`);
}

const response = await requestShutdown(port);
if (response !== 'OK shutdown') {
  throw new Error(`Unexpected DeskMCP control response: ${response}`);
}

console.error(`[desktop-mcp] graceful shutdown requested on port ${port}`);
