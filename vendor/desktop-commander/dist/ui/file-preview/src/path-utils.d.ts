export declare function isWindowsAbsolutePath(value: string): boolean;
export declare function normalizePathSeparators(value: string): string;
export declare function normalizeFilePath(value: string): string;
export declare function getParentDirectory(filePath: string): string;
export declare function getAncestorDirectories(filePath: string): string[];
export declare function toPosixRelativePath(fromDirectory: string, targetPath: string): string;
