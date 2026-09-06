import { WinAppComputerBackend } from './computer-use-backend.js';
import { ComputerObservationRegistry } from './computer-use-observation.js';
import { ComputerUseCoordinator, ComputerWindowRegistry } from './computer-use-registry.js';

export interface ComputerUseRuntime {
  readonly backend: WinAppComputerBackend;
  readonly windows: ComputerWindowRegistry;
  readonly observations: ComputerObservationRegistry;
  readonly coordinator: ComputerUseCoordinator;
}

export function createComputerUseRuntime(): ComputerUseRuntime {
  return {
    backend: new WinAppComputerBackend(),
    windows: new ComputerWindowRegistry(),
    observations: new ComputerObservationRegistry(),
    coordinator: new ComputerUseCoordinator()
  };
}
