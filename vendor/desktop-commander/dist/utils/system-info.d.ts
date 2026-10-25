export interface DockerMount {
    hostPath: string;
    containerPath: string;
    type: 'bind' | 'volume';
    readOnly: boolean;
    description: string;
}
export interface ContainerInfo {
    isContainer: boolean;
    containerType: 'docker' | 'podman' | 'kubernetes' | 'lxc' | 'systemd-nspawn' | 'other' | null;
    orchestrator: 'kubernetes' | 'docker-compose' | 'docker-swarm' | 'podman-compose' | null;
    isDocker: boolean;
    mountPoints: DockerMount[];
    containerEnvironment?: {
        dockerImage?: string;
        containerName?: string;
        hostPlatform?: string;
        kubernetesNamespace?: string;
        kubernetesPod?: string;
        kubernetesNode?: string;
    };
}
export interface SystemInfo {
    platform: string;
    platformName: string;
    defaultShell: string;
    pathSeparator: string;
    isWindows: boolean;
    isMacOS: boolean;
    isLinux: boolean;
    docker: ContainerInfo;
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
}
/**
 * Get comprehensive system information for tool prompts
 */
export declare function getSystemInfo(): SystemInfo;
/**
 * Generate OS-specific guidance for tool prompts
 */
export declare function getOSSpecificGuidance(systemInfo: SystemInfo): string;
/**
 * Get common development tool guidance based on OS
 */
export declare function getDevelopmentToolGuidance(systemInfo: SystemInfo): string;
/**
 * Get path guidance (simplified since paths are normalized)
 */
export declare function getPathGuidance(systemInfo: SystemInfo): string;
