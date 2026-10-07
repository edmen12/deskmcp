import { z } from "zod";
export declare const GetConfigArgsSchema: z.ZodObject<{
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    origin?: "ui" | "llm" | undefined;
}, {
    origin?: "ui" | "llm" | undefined;
}>;
export declare const SetConfigValueArgsSchema: z.ZodObject<{
    key: z.ZodString;
    value: z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString, "many">, z.ZodNull]>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    value: string | number | boolean | string[] | null;
    key: string;
    origin?: "ui" | "llm" | undefined;
}, {
    value: string | number | boolean | string[] | null;
    key: string;
    origin?: "ui" | "llm" | undefined;
}>;
export declare const ListProcessesArgsSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare const StartProcessArgsSchema: z.ZodObject<{
    command: z.ZodString;
    timeout_ms: z.ZodNumber;
    shell: z.ZodOptional<z.ZodString>;
    verbose_timing: z.ZodOptional<z.ZodBoolean>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    command: string;
    timeout_ms: number;
    origin?: "ui" | "llm" | undefined;
    shell?: string | undefined;
    verbose_timing?: boolean | undefined;
}, {
    command: string;
    timeout_ms: number;
    origin?: "ui" | "llm" | undefined;
    shell?: string | undefined;
    verbose_timing?: boolean | undefined;
}>;
export declare const ReadProcessOutputArgsSchema: z.ZodObject<{
    pid: z.ZodNumber;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    length: z.ZodOptional<z.ZodNumber>;
    verbose_timing: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    pid: number;
    length?: number | undefined;
    timeout_ms?: number | undefined;
    verbose_timing?: boolean | undefined;
    offset?: number | undefined;
}, {
    pid: number;
    length?: number | undefined;
    timeout_ms?: number | undefined;
    verbose_timing?: boolean | undefined;
    offset?: number | undefined;
}>;
export declare const ForceTerminateArgsSchema: z.ZodObject<{
    pid: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    pid: number;
}, {
    pid: number;
}>;
export declare const ListSessionsArgsSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare const KillProcessArgsSchema: z.ZodObject<{
    pid: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    pid: number;
}, {
    pid: number;
}>;
export declare const ReadFileArgsSchema: z.ZodObject<{
    path: z.ZodString;
    isUrl: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    offset: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    length: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    sheet: z.ZodOptional<z.ZodString>;
    range: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    length: number;
    path: string;
    offset: number;
    isUrl: boolean;
    origin?: "ui" | "llm" | undefined;
    options?: Record<string, any> | undefined;
    sheet?: string | undefined;
    range?: string | undefined;
}, {
    path: string;
    length?: number | undefined;
    origin?: "ui" | "llm" | undefined;
    options?: Record<string, any> | undefined;
    offset?: number | undefined;
    isUrl?: boolean | undefined;
    sheet?: string | undefined;
    range?: string | undefined;
}>;
export declare const ReadMultipleFilesArgsSchema: z.ZodObject<{
    paths: z.ZodArray<z.ZodString, "many">;
}, "strip", z.ZodTypeAny, {
    paths: string[];
}, {
    paths: string[];
}>;
export declare const WriteFileArgsSchema: z.ZodObject<{
    path: z.ZodString;
    content: z.ZodString;
    mode: z.ZodDefault<z.ZodEnum<["rewrite", "append"]>>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    content: string;
    mode: "rewrite" | "append";
    origin?: "ui" | "llm" | undefined;
}, {
    path: string;
    content: string;
    origin?: "ui" | "llm" | undefined;
    mode?: "rewrite" | "append" | undefined;
}>;
export declare const PdfInsertOperationSchema: z.ZodObject<{
    type: z.ZodLiteral<"insert">;
    pageIndex: z.ZodNumber;
    markdown: z.ZodOptional<z.ZodString>;
    sourcePdfPath: z.ZodOptional<z.ZodString>;
    pdfOptions: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
}, "strip", z.ZodTypeAny, {
    type: "insert";
    pageIndex: number;
    markdown?: string | undefined;
    sourcePdfPath?: string | undefined;
    pdfOptions?: z.objectOutputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
}, {
    type: "insert";
    pageIndex: number;
    markdown?: string | undefined;
    sourcePdfPath?: string | undefined;
    pdfOptions?: z.objectInputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
}>;
export declare const PdfDeleteOperationSchema: z.ZodObject<{
    type: z.ZodLiteral<"delete">;
    pageIndexes: z.ZodArray<z.ZodNumber, "many">;
}, "strip", z.ZodTypeAny, {
    type: "delete";
    pageIndexes: number[];
}, {
    type: "delete";
    pageIndexes: number[];
}>;
export declare const PdfOperationSchema: z.ZodUnion<[z.ZodObject<{
    type: z.ZodLiteral<"insert">;
    pageIndex: z.ZodNumber;
    markdown: z.ZodOptional<z.ZodString>;
    sourcePdfPath: z.ZodOptional<z.ZodString>;
    pdfOptions: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
}, "strip", z.ZodTypeAny, {
    type: "insert";
    pageIndex: number;
    markdown?: string | undefined;
    sourcePdfPath?: string | undefined;
    pdfOptions?: z.objectOutputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
}, {
    type: "insert";
    pageIndex: number;
    markdown?: string | undefined;
    sourcePdfPath?: string | undefined;
    pdfOptions?: z.objectInputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
}>, z.ZodObject<{
    type: z.ZodLiteral<"delete">;
    pageIndexes: z.ZodArray<z.ZodNumber, "many">;
}, "strip", z.ZodTypeAny, {
    type: "delete";
    pageIndexes: number[];
}, {
    type: "delete";
    pageIndexes: number[];
}>]>;
export declare const WritePdfArgsSchema: z.ZodObject<{
    path: z.ZodString;
    content: z.ZodEffects<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodUnion<[z.ZodObject<{
        type: z.ZodLiteral<"insert">;
        pageIndex: z.ZodNumber;
        markdown: z.ZodOptional<z.ZodString>;
        sourcePdfPath: z.ZodOptional<z.ZodString>;
        pdfOptions: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
    }, "strip", z.ZodTypeAny, {
        type: "insert";
        pageIndex: number;
        markdown?: string | undefined;
        sourcePdfPath?: string | undefined;
        pdfOptions?: z.objectOutputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
    }, {
        type: "insert";
        pageIndex: number;
        markdown?: string | undefined;
        sourcePdfPath?: string | undefined;
        pdfOptions?: z.objectInputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"delete">;
        pageIndexes: z.ZodArray<z.ZodNumber, "many">;
    }, "strip", z.ZodTypeAny, {
        type: "delete";
        pageIndexes: number[];
    }, {
        type: "delete";
        pageIndexes: number[];
    }>]>, "many">]>, string | ({
        type: "insert";
        pageIndex: number;
        markdown?: string | undefined;
        sourcePdfPath?: string | undefined;
        pdfOptions?: z.objectOutputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
    } | {
        type: "delete";
        pageIndexes: number[];
    })[], unknown>;
    outputPath: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{}, "passthrough", z.ZodTypeAny, z.objectOutputType<{}, z.ZodTypeAny, "passthrough">, z.objectInputType<{}, z.ZodTypeAny, "passthrough">>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    content: string | ({
        type: "insert";
        pageIndex: number;
        markdown?: string | undefined;
        sourcePdfPath?: string | undefined;
        pdfOptions?: z.objectOutputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
    } | {
        type: "delete";
        pageIndexes: number[];
    })[];
    options?: z.objectOutputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
    outputPath?: string | undefined;
}, {
    path: string;
    options?: z.objectInputType<{}, z.ZodTypeAny, "passthrough"> | undefined;
    content?: unknown;
    outputPath?: string | undefined;
}>;
export declare const CreateDirectoryArgsSchema: z.ZodObject<{
    path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
}, {
    path: string;
}>;
export declare const ListDirectoryArgsSchema: z.ZodObject<{
    path: z.ZodString;
    depth: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    depth: number;
    origin?: "ui" | "llm" | undefined;
}, {
    path: string;
    origin?: "ui" | "llm" | undefined;
    depth?: number | undefined;
}>;
export declare const MoveFileArgsSchema: z.ZodObject<{
    source: z.ZodString;
    destination: z.ZodString;
}, "strip", z.ZodTypeAny, {
    source: string;
    destination: string;
}, {
    source: string;
    destination: string;
}>;
export declare const GetFileInfoArgsSchema: z.ZodObject<{
    path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
}, {
    path: string;
}>;
export declare const EditBlockArgsSchema: z.ZodEffects<z.ZodObject<{
    file_path: z.ZodString;
    old_string: z.ZodOptional<z.ZodString>;
    new_string: z.ZodOptional<z.ZodString>;
    expected_replacements: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    range: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodAny>;
    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    file_path: string;
    expected_replacements: number;
    origin?: "ui" | "llm" | undefined;
    options?: Record<string, any> | undefined;
    range?: string | undefined;
    content?: any;
    old_string?: string | undefined;
    new_string?: string | undefined;
}, {
    file_path: string;
    origin?: "ui" | "llm" | undefined;
    options?: Record<string, any> | undefined;
    range?: string | undefined;
    content?: any;
    old_string?: string | undefined;
    new_string?: string | undefined;
    expected_replacements?: number | undefined;
}>, {
    file_path: string;
    expected_replacements: number;
    origin?: "ui" | "llm" | undefined;
    options?: Record<string, any> | undefined;
    range?: string | undefined;
    content?: any;
    old_string?: string | undefined;
    new_string?: string | undefined;
}, {
    file_path: string;
    origin?: "ui" | "llm" | undefined;
    options?: Record<string, any> | undefined;
    range?: string | undefined;
    content?: any;
    old_string?: string | undefined;
    new_string?: string | undefined;
    expected_replacements?: number | undefined;
}>;
export declare const InteractWithProcessArgsSchema: z.ZodObject<{
    pid: z.ZodNumber;
    input: z.ZodString;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
    wait_for_prompt: z.ZodOptional<z.ZodBoolean>;
    verbose_timing: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    pid: number;
    input: string;
    timeout_ms?: number | undefined;
    verbose_timing?: boolean | undefined;
    wait_for_prompt?: boolean | undefined;
}, {
    pid: number;
    input: string;
    timeout_ms?: number | undefined;
    verbose_timing?: boolean | undefined;
    wait_for_prompt?: boolean | undefined;
}>;
export declare const GetUsageStatsArgsSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare const GiveFeedbackArgsSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare const StartSearchArgsSchema: z.ZodObject<{
    path: z.ZodString;
    pattern: z.ZodString;
    searchType: z.ZodDefault<z.ZodEnum<["files", "content"]>>;
    filePattern: z.ZodOptional<z.ZodString>;
    ignoreCase: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    maxResults: z.ZodOptional<z.ZodNumber>;
    includeHidden: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    contextLines: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    timeout_ms: z.ZodOptional<z.ZodNumber>;
    earlyTermination: z.ZodOptional<z.ZodBoolean>;
    literalSearch: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    origin: z.ZodOptional<z.ZodEnum<["ui", "llm"]>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    pattern: string;
    searchType: "content" | "files";
    ignoreCase: boolean;
    includeHidden: boolean;
    contextLines: number;
    literalSearch: boolean;
    origin?: "ui" | "llm" | undefined;
    timeout_ms?: number | undefined;
    filePattern?: string | undefined;
    maxResults?: number | undefined;
    earlyTermination?: boolean | undefined;
}, {
    path: string;
    pattern: string;
    origin?: "ui" | "llm" | undefined;
    timeout_ms?: number | undefined;
    searchType?: "content" | "files" | undefined;
    filePattern?: string | undefined;
    ignoreCase?: boolean | undefined;
    maxResults?: number | undefined;
    includeHidden?: boolean | undefined;
    contextLines?: number | undefined;
    earlyTermination?: boolean | undefined;
    literalSearch?: boolean | undefined;
}>;
export declare const GetMoreSearchResultsArgsSchema: z.ZodObject<{
    sessionId: z.ZodString;
    offset: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    length: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
}, "strip", z.ZodTypeAny, {
    length: number;
    offset: number;
    sessionId: string;
}, {
    sessionId: string;
    length?: number | undefined;
    offset?: number | undefined;
}>;
export declare const StopSearchArgsSchema: z.ZodObject<{
    sessionId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    sessionId: string;
}, {
    sessionId: string;
}>;
export declare const ListSearchesArgsSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
export declare const GetPromptsArgsSchema: z.ZodObject<{
    action: z.ZodEnum<["get_prompt"]>;
    promptId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    action: "get_prompt";
    promptId: string;
}, {
    action: "get_prompt";
    promptId: string;
}>;
export declare const GetRecentToolCallsArgsSchema: z.ZodObject<{
    maxResults: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    toolName: z.ZodOptional<z.ZodString>;
    since: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    maxResults: number;
    toolName?: string | undefined;
    since?: string | undefined;
}, {
    maxResults?: number | undefined;
    toolName?: string | undefined;
    since?: string | undefined;
}>;
export declare const TrackUiEventArgsSchema: z.ZodObject<{
    event: z.ZodString;
    component: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    params: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>>>;
}, "strip", z.ZodTypeAny, {
    params: Record<string, string | number | boolean | null>;
    event: string;
    component: string;
}, {
    event: string;
    params?: Record<string, string | number | boolean | null> | undefined;
    component?: string | undefined;
}>;
/**
 * Map of tool name -> argument schema, used by the dispatcher to detect and warn
 * about parameters a caller sent that the tool does not support. Keep in sync
 * with the tool definitions in server.ts.
 */
export declare const toolArgSchemas: Record<string, z.ZodTypeAny>;
