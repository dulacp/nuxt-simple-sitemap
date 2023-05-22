import type { ResolvedSitemapEntry } from '../../types';
import type { BuildSitemapOptions } from './builder';
export declare function generateSitemapEntries(options: BuildSitemapOptions): Promise<ResolvedSitemapEntry[]>;
