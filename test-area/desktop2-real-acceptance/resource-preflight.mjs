import os from 'node:os';

export const MIN_NATIVE_GUI_FREE_MB = 1200;

// The real-Windows Desktop2 GUI acceptance helper is user-desktop-sensitive.
// Refuse to launch when Windows available physical memory is unstable/low.
// No override environment variable, silent retry, process killing, or VM.
export async function requireSafeNativeGuiMemory({
  freeBytes = () => os.freemem(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  minMb = MIN_NATIVE_GUI_FREE_MB,
  samples = 3
} = {}) {
  if (!Number.isSafeInteger(samples) || samples < 2 || samples > 4
      || !Number.isSafeInteger(minMb) || minMb < 1024)
    throw Error('NATIVE_GUI_MEMORY_GATE_CONFIGURATION_INVALID');
  const seenMb = [];
  for (let i = 0; i < samples; i++) {
    const bytes = freeBytes();
    if (!Number.isFinite(bytes) || bytes < 0)
      throw Error('NATIVE_GUI_FREE_MEMORY_UNAVAILABLE');
    const mb = Math.floor(bytes / (1024 * 1024));
    seenMb.push(mb);
    if (mb < minMb)
      throw Error('NATIVE_GUI_INSUFFICIENT_HOST_MEMORY:' + mb + 'MB<'+minMb+'MB');
    if (i + 1 < samples) await pause(150);
  }
  return {minMb, seenMb};
}
