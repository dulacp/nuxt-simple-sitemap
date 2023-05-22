import type { NuxtPage } from '@nuxt/schema';
export declare function mergeOnKey<T, K extends keyof T>(arr: T[], key: K): T[];
export declare function resolvePagesRoutes(pagesDirs: string[], extensions: string[]): Promise<NuxtPage[]>;
export declare function normalisePagesForSitemap(allRoutes: NuxtPage[]): NuxtPage[];
export declare function generateRoutesFromFiles(files: string[], pagesDir: string): NuxtPage[];
export declare function normalizeRoutes(routes: NuxtPage[], metaImports?: Set<string>): {
    imports: Set<string>;
    routes: string;
};
