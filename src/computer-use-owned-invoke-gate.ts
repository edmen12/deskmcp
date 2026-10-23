import type { UiElementSummary, WindowInspection } from './computer-use-backend.js';

/**
 * Lab-only admission for exactly one owned WinForms Button Invoke.
 * Not registered as an MCP tool, not a general native-action permission.
 */
export interface OwnedWinFormsInvokeProof {
  readonly ownerDesktopNumber: number;
  readonly leaseActive: boolean;
  readonly independentObserverReady: boolean;
  readonly rootHwnd: number;
  readonly childRootHwnd: number;
  readonly processId: number;
  readonly childProcessId: number;
  readonly rootClass: string;
  readonly appAssemblySha256: string;
  readonly rootNoActivate: boolean;
  readonly appInitialized: boolean;
  readonly currentSelectionGeneration: number;
  readonly expectedSelectionGeneration: number;
}
export const OWNED_WINFORMS_FIXTURE_DLL_SHA256 =
  'f179ccd122ff888bff9081cc53b562c98b331237c537f0dcb8c29486256596b0';

export class OwnedWinFormsInvokeTrial {
  private dispatched = false;
  readonly authorizedForProduction = false;

  admit(proof: OwnedWinFormsInvokeProof, inspection: WindowInspection): string {
    if (this.dispatched) throw new Error('OWNED_INVOKE_ALREADY_USED');
    if (proof.ownerDesktopNumber !== 1 || !proof.leaseActive ||
      !proof.independentObserverReady || !proof.rootNoActivate || !proof.appInitialized)
      throw new Error('OWNED_INVOKE_DESKTOP_OR_MONITOR_NOT_READY');
    if (!Number.isSafeInteger(proof.rootHwnd) || proof.rootHwnd < 1 ||
      proof.rootHwnd !== proof.childRootHwnd ||
      !Number.isSafeInteger(proof.processId) || proof.processId < 1 ||
      proof.processId !== proof.childProcessId ||
      !proof.rootClass.startsWith('WindowsForms10.Window.') ||
      proof.appAssemblySha256 !== OWNED_WINFORMS_FIXTURE_DLL_SHA256 ||
      proof.currentSelectionGeneration !== proof.expectedSelectionGeneration)
      throw new Error('OWNED_INVOKE_APPLICATION_IDENTITY_CHANGED');
    if (inspection.hwnd !== proof.rootHwnd || inspection.elementsTruncated === true)
      throw new Error('OWNED_INVOKE_PROVIDER_SCOPE_INCOMPLETE');
    const buttons = inspection.elements.filter(item =>
      item.automationId === 'OwnedNativePushButton' ||
      (item.type === 'Button' && item.name === 'Test action'));
    if (buttons.length !== 1) throw new Error('OWNED_INVOKE_TARGET_NOT_UNIQUE');
    const button: UiElementSummary = buttons[0]!;
    if (button.type !== 'Button' ||
      button.name !== 'Test action' ||
      button.isEnabled !== true ||
      button.isInvokable !== true ||
      typeof button.selector !== 'string' || !button.selector.trim())
      throw new Error('OWNED_INVOKE_UNSUPPORTED_PROVIDER');
    return button.selector;
  }

  claimOnce(proof: OwnedWinFormsInvokeProof, inspection: WindowInspection): string {
    const selector = this.admit(proof, inspection);
    // Mark used *before* transport; a timeout is not evidence of non-delivery.
    this.dispatched = true;
    return selector;
  }

  attestAppEffect(
    eventLines: readonly string[],
    ownerDesktopAfter: number,
    monitorQuiet: boolean,
    ownedJobExited: boolean,
    observerExited: boolean,
    leaseHeldThroughCleanup: boolean
  ) {
    if (!this.dispatched) throw new Error('OWNED_INVOKE_NEVER_DISPATCHED');
    const callbacks = eventLines.filter(line => /\bAPP_BUTTON_CLICK=\d+\s*$/u.test(line));
    const focusChanges = eventLines.filter(line =>
      /\b(ROOT_WM_(6|7|8|1C)|BUTTON_WM_(6|7|8))\b/u.test(line));
    if (callbacks.length !== 1 || !callbacks[0]?.endsWith('APP_BUTTON_CLICK=1') ||
      focusChanges.length > 0 || ownerDesktopAfter !== 1 || !monitorQuiet ||
      !ownedJobExited || !observerExited || !leaseHeldThroughCleanup)
      throw new Error('OWNED_INVOKE_APP_EFFECT_OR_SAFETY_UNVERIFIED');
    return { status: 'owned_fixture_callback_confirmed' as const,
      callback_count: 1 as const, production_action_authorized: false as const };
  }
}
