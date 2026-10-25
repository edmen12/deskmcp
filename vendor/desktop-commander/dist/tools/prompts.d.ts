import { ServerResult } from '../types.js';
interface Prompt {
    id: string;
    title: string;
    description: string;
    prompt: string;
    categories: string[];
    secondaryTag?: string;
    votes: number;
    gaClicks: number;
    icon: string;
    author: string;
    verified: boolean;
}
export interface PromptsData {
    version: string;
    description: string;
    prompts: Prompt[];
}
/**
 * Load prompts data from JSON file with caching
 */
export declare function loadPromptsData(): Promise<PromptsData>;
/**
 * Get prompts - SIMPLIFIED VERSION (only get_prompt action)
 */
export declare function getPrompts(params: any): Promise<ServerResult>;
export {};
