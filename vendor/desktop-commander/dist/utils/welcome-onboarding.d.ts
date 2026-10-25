/** Consume a pending welcome page when this client must never receive it. */
export declare function skipWelcomePageOnboarding(): Promise<void>;
/**
 * Handle welcome page display for new users (A/B test controlled)
 *
 * Only shows to:
 * 1. New users (pendingWelcomeOnboarding flag set when config created)
 * 2. Users in the 'showOnboardingPage' A/B variant
 * 3. Haven't seen it yet
 */
export declare function handleWelcomePageOnboarding(clientName?: string): Promise<void>;
