import type { NuxtSimpleSitemapRuntime, SitemapIndexEntry, SitemapRenderCtx } from '../../types';
export interface BuildSitemapOptions {
    sitemapConfig: NuxtSimpleSitemapRuntime;
    baseURL: string;
    getRouteRulesForPath: (path: string) => Record<string, any>;
    callHook?: (ctx: SitemapRenderCtx) => Promise<void>;
}
export declare function buildSitemapIndex(options: BuildSitemapOptions): Promise<{
    sitemaps: SitemapIndexEntry[];
    xml: string;
}>;
export declare function buildSitemap(options: BuildSitemapOptions & {
    sitemapName: string;
}): Promise<string>;
export declare function normaliseValue(key: string, value: any, options: BuildSitemapOptions): string | false;
export declare function generateXslStylesheet(): string;
