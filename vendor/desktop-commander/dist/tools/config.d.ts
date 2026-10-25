/**
 * Get the entire config including system information
 */
export declare function getConfig(): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    structuredContent: {
        config: {
            currentClient: {
                name: string;
                version: string;
            };
            featureFlags: Record<string, any>;
            systemInfo: {
                memory: {
                    rss: string;
                    heapTotal: string;
                    heapUsed: string;
                    external: string;
                    arrayBuffers: string;
                };
                platform: string;
                platformName: string;
                defaultShell: string;
                pathSeparator: string;
                isWindows: boolean;
                isMacOS: boolean;
                isLinux: boolean;
                docker: import("../utils/system-info.js").ContainerInfo;
                isDXT: boolean;
                nodeInfo?: {
                    version: string;
                    path: string;
                    npmVersion?: string;
                };
                pythonInfo?: {
                    available: boolean;
                    command: string;
                    version?: string;
                };
                processInfo: {
                    pid: number;
                    arch: string;
                    platform: string;
                    versions: NodeJS.ProcessVersions;
                };
                examplePaths: {
                    home: string;
                    temp: string;
                    absolute: string;
                    accessible?: string[];
                };
            };
            blockedCommands?: string[];
            defaultShell?: string;
            allowedDirectories?: string[];
            telemetryEnabled?: boolean;
            fileWriteLineLimit?: number;
            fileReadLineLimit?: number;
            clientId?: string;
        };
        uiHints: {
            availableShells: string[];
        };
        entries: {
            key: "defaultShell" | "blockedCommands" | "allowedDirectories" | "telemetryEnabled" | "fileReadLineLimit" | "fileWriteLineLimit";
            value: unknown;
            valueType: "string" | "number" | "boolean" | "array";
            editable: boolean;
        }[];
    };
} | {
    content: {
        type: string;
        text: string;
    }[];
    structuredContent?: undefined;
}>;
/**
 * Set a specific config value
 */
export declare function setConfigValue(args: unknown): Promise<{
    content: {
        type: string;
        text: string;
    }[];
    isError: boolean;
} | {
    content: {
        type: string;
        text: string;
    }[];
    isError?: undefined;
}>;
