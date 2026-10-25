import { ReadFileArgsSchema, StartProcessArgsSchema } from '../../vendor/desktop-commander/dist/tools/schemas.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const validRead=ReadFileArgsSchema.safeParse({path:'C:/test-only.txt'});
const invalidRead=ReadFileArgsSchema.safeParse({path:123});
const validProcess=StartProcessArgsSchema.safeParse({command:'echo dummy',timeout_ms:1000});
const invalidProcess=StartProcessArgsSchema.safeParse({command:'echo dummy'});
let converted,convertedError='';
try {converted=zodToJsonSchema(ReadFileArgsSchema);}catch(e){convertedError=String(e);}
const report={
 readValid:validRead.success,
 readInvalidRejected:!invalidRead.success,
 processValid:validProcess.success,
 processInvalidRejected:!invalidProcess.success,
 schemaHasRequiredPath:!!converted?.properties?.path && !!converted?.required?.includes('path'),
 schemaType:converted?.type,
 convertedError,
 schemaPreview:JSON.stringify(converted||{}).slice(0,180)
};
console.log(JSON.stringify(report));
if(!report.readValid||!report.readInvalidRejected||
   !report.processValid||!report.processInvalidRejected||
   !report.schemaHasRequiredPath)process.exitCode=2;
