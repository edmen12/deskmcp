import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { AuditLogger } from './audit.js';
import { PolicyDeniedError, type DesktopPolicy } from './desktop-policy.js';
import { receiveFile } from './file-ingress-core.js';

export function registerFileIngressTools(server: McpServer, policy: DesktopPolicy, audit: AuditLogger): void {
  server.registerTool('desktop_receive_chatgpt_file', {
    title: 'Receive ChatGPT file',
    description: 'Save an authorized ChatGPT PNG/APNG/ZIP attachment to a new file inside the locally configured ingress root. Never overwrite. Requires an explicitly configured ingress root and writable profile. Optional expected size and SHA-256 validate exact bytes.',
    inputSchema: z.object({
      file: z.object({
        download_url: z.string().url().max(16384),
        file_id: z.string().min(1).max(512),
        mime_type: z.string().max(256).optional(),
        file_name: z.string().max(512).optional()
      }).strict(),
      path: z.string().min(1).max(4096),
      expected_size: z.number().int().min(1).max(134217728).optional(),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { 'openai/fileParams': ['file'] }
  }, async input => {
    let operation;
    try {
      operation=await audit.begin('desktop_receive_chatgpt_file','write',policy.profile,input.path);
      policy.assertCanWrite();
      const root=process.env.DESKTOP_MCP_FILE_INGRESS_ROOT;
      if (!root) throw new PolicyDeniedError('File ingress disabled; configure an explicit local root.');
      const target=await policy.resolveNewWritePath(input.path);
      const result=await receiveFile({downloadUrl:input.file.download_url,target,root,
        ...(input.expected_size!==undefined?{expectedSize:input.expected_size}:{}),
        ...(input.expected_sha256!==undefined?{expectedSha256:input.expected_sha256}:{})});
      await audit.finish(operation,'allow');
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    } catch(error) {
      if(operation) await audit.finish(operation,error instanceof PolicyDeniedError?'deny':'fail',error).catch(()=>{});
      return {content:[{type:'text' as const,text:'File receipt denied or failed. Check local ingress configuration and integrity.'}],isError:true};
    }
  });
}
