import { checkLatestUpdate } from './update-client.js';

const currentVersion = process.argv[2];
const target = process.argv[3] ?? 'win-x64';

if (!currentVersion) {
  console.error('Usage: update-check <current-version> <target>');
  process.exitCode = 2;
} else {
  try {
    const result = await checkLatestUpdate(currentVersion, target);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
