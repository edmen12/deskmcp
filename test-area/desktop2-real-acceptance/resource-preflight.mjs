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


// Monitor-only acceptance does not create/open/interact with application GUI.
// It starts only our private WinEvent/VDA observation process. Keep its
// independent resource gate smaller than the unmodified 1200 MiB GUI gate.
// The caller must never use this for fixture or third-party GUI launch.
export const MIN_PASSIVE_OBSERVER_FREE_MB = 768;

export async function requireSafePassiveObserverMemory({
  freeBytes = () => os.freemem(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  samples = 3
} = {}) {
  if(!Number.isSafeInteger(samples) || samples !== 3)
    throw Error('PASSIVE_OBSERVER_SAMPLE_COUNT_INVALID');
  const seenMb=[];
  for(let i=0;i<3;i++){
    const bytes=freeBytes();
    if(!Number.isFinite(bytes)||bytes<0)
      throw Error('PASSIVE_OBSERVER_FREE_MEMORY_UNAVAILABLE');
    const mb=Math.floor(bytes/(1024*1024));
    seenMb.push(mb);
    if(mb<MIN_PASSIVE_OBSERVER_FREE_MB)
      throw Error('PASSIVE_OBSERVER_INSUFFICIENT_HOST_MEMORY:'+mb+
        'MB<'+MIN_PASSIVE_OBSERVER_FREE_MB+'MB');
    if(i<2)await pause(150);
  }
  return {minMb:MIN_PASSIVE_OBSERVER_FREE_MB,seenMb};
}
