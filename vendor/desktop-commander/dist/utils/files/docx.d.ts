/**
 * DOCX File Handler
 *
 * Approach: expose DOCX as filtered/raw XML through existing read_file + edit_block.
 *
 * READ (default): Returns a text-bearing outline — skips shapes, drawings, SVG noise.
 *   Shows paragraphs with text, tables with cell content, style info, and image refs.
 *   Each element shows its raw XML tag context so Claude can target it for editing.
 *
 * READ (with offset/length): Returns raw pretty-printed XML with line pagination,
 *   so Claude can drill into specific sections when the outline isn't enough.
 *
 * EDIT (old_string/new_string): Find/replace on the pretty-printed XML, then
 *   compact and repack into valid DOCX. Works exactly like text file editing.
 *
 * Round-trip: DOCX → unzip → pretty-print → [outline or raw] → edit → compact → repack
 */
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
export declare class DocxFileHandler implements FileHandler {
    private readonly extensions;
    canHandle(path: string): boolean;
    /**
     * Read DOCX content.
     *
     * Default (offset=0, no explicit length or default length): returns outline
     * With offset/length: returns raw pretty-printed XML with line pagination
     */
    read(path: string, options?: ReadOptions): Promise<FileResult>;
    /**
     * Write/create a DOCX file.
     * Content is plain text — each line becomes a paragraph.
     * Lines starting with # become headings (# = Heading1, ## = Heading2, etc.)
     */
    write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void>;
    /**
     * Edit DOCX via find/replace on pretty-printed XML.
     *
     * Works on the same representation that read() returns when using offset/length,
     * so XML fragments copied from read output work as search strings.
     * After editing, XML is compacted and repacked into the DOCX.
     */
    editRange(path: string, _range: string, content: any, options?: Record<string, any>): Promise<EditResult>;
    /**
     * Get DOCX file info
     */
    getInfo(path: string): Promise<FileInfo>;
}
