export type ConfigFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'null';
export type ConfigFieldDefinition = {
    label: string;
    description: string;
    valueType: ConfigFieldValueType;
};
export declare const CONFIG_FIELD_DEFINITIONS: {
    readonly blockedCommands: {
        readonly label: "Blocked Commands";
        readonly description: "This is your personal safety blocklist. If a command appears here, Desktop Commander will refuse to run it even if a prompt asks for it. Add risky commands you never want executed by mistake.";
        readonly valueType: "array";
    };
    readonly allowedDirectories: {
        readonly label: "Allowed Folders";
        readonly description: "These are the folders Desktop Commander is allowed to read and edit. Think of this as a permission list. Keeping it small is safer. If this list is empty, Desktop Commander can access your entire filesystem.";
        readonly valueType: "array";
    };
    readonly defaultShell: {
        readonly label: "Default Shell";
        readonly description: "This is the shell used for new command sessions (for example /bin/bash or /bin/zsh). Only change this if you know your environment requires a specific shell.";
        readonly valueType: "string";
    };
    readonly telemetryEnabled: {
        readonly label: "Anonymous Telemetry";
        readonly description: "When on, Desktop Commander sends anonymous usage information that helps improve product quality. When off, no telemetry data is sent.";
        readonly valueType: "boolean";
    };
    readonly fileReadLineLimit: {
        readonly label: "File Read Limit";
        readonly description: "Maximum number of lines returned from a file in one read action. Lower numbers keep responses short and safer; higher numbers return more text at once.";
        readonly valueType: "number";
    };
    readonly fileWriteLineLimit: {
        readonly label: "File Write Limit";
        readonly description: "Maximum number of lines that can be written in one edit operation. This helps prevent accidental oversized writes and keeps file changes predictable.";
        readonly valueType: "number";
    };
};
export type ConfigFieldKey = keyof typeof CONFIG_FIELD_DEFINITIONS;
export declare const CONFIG_FIELD_KEYS: ConfigFieldKey[];
export declare function isConfigFieldKey(value: string): value is ConfigFieldKey;
