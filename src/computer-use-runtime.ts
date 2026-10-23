import { WinAppComputerBackend } from './computer-use-backend.js';
import { ComputerObservationRegistry } from './computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from './computer-use-registry.js';
import { ComputerSnapshotRegistry } from './computer-use-read-model.js';

export interface ComputerUseRuntime {
  readonly backend: WinAppComputerBackend;
  readonly windows: ComputerWindowRegistry;
  readonly observations: ComputerObservationRegistry;
  readonly snapshots: ComputerSnapshotRegistry;
  readonly coordinator: ComputerUseCoordinator;
}

export function createComputerUseRuntime(): ComputerUseRuntime {
  return {
    backend: new WinAppComputerBackend(),
    windows: new ComputerWindowRegistry(),
    observations: new ComputerObservationRegistry(),
    snapshots: new ComputerSnapshotRegistry(),
    coordinator: new ComputerUseCoordinator()
  };
}
