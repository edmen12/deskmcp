import open from 'open';
import { captureRemote } from '../utils/capture.js';
interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}
type DeviceAuthenticatorDeps = {
    fetch?: typeof fetch;
    open?: typeof open;
    capture?: typeof captureRemote;
    monotonicNow?: () => number;
};
export declare class DeviceAuthenticator {
    private baseServerUrl;
    private fetchFn;
    private openFn;
    private captureFn;
    private monotonicNow;
    constructor(baseServerUrl: string, deps?: DeviceAuthenticatorDeps);
    authenticate(deviceId?: string): Promise<AuthSession>;
    private generatePKCE;
    private requestDeviceCode;
    private displayUserInstructions;
    private pollForAuthorization;
    private sleep;
}
export {};
