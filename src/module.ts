import { writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { addServerHandler, addTemplate, createResolver, defineNuxtModule, useLogger } from '@nuxt/kit'
import { defu } from 'defu'
import type { SitemapStreamOptions } from 'sitemap'
import { SitemapStream, streamToPromise } from 'sitemap'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import type { Nitro } from 'nitropack'
import chalk from 'chalk'
import type { CreateFilterOptions } from './urlFilter'
import { createFilter } from './urlFilter'

export interface ModuleOptions extends CreateFilterOptions, SitemapStreamOptions {
  /**
   * Whether the sitemap.xml should be generated.
   *
   * @default process.env.NODE_ENV === 'production'
   */
  enabled: boolean
}

export interface ModuleHooks {
  'sitemap:generate': (ctx: { urls: string[]; sitemap: SitemapStream }) => Promise<void>
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-simple-sitemap',
    version: '3.0.0',
    compatibility: {
      nuxt: '^3.0.0',
      bridge: false,
    },
    configKey: 'sitemap',
  },
  defaults(nuxt) {
    return {
      include: ['/**'],
      hostname: nuxt.options.runtimeConfig.host,
      enabled: process.env.NODE_ENV === 'production',
    }
  },
  setup(config, nuxt) {
    // make sure a hostname is set so we can generate the sitemap
    config.hostname = config.hostname || 'https://example.com'
    const { resolve } = createResolver(import.meta.url)

    // paths.d.ts
    addTemplate({
      filename: 'sitemap.d.ts',
      getContents: () => {
        return `// Generated by nuxt-simple-sitemap
declare module 'nitropack' {
  interface NitroRouteRules {
    index?: boolean
    sitemap?: {
      priority?: number
      changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
    }
  }
}
`
      },
    })

    nuxt.hooks.hook('prepare:types', ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, 'nuxt-seo-kit.d.ts') })
    })

    if (nuxt.options.dev) {
      // give a warning when accessing sitemap in dev mode
      addServerHandler({
        route: '/sitemap.xml',
        handler: resolve('./runtime/dev-sitemap'),
      })
      return
    }
    nuxt.hooks.hook('nitro:init', async (nitro: Nitro) => {
      // tell the user if the sitemap isn't being generated
      const logger = useLogger('nuxt-simple-sitemap')
      if (!config.enabled) {
        logger.warn('Sitemap generation is disabled. Set `sitemap.enabled` to `true` to enable it.')
        return
      }

      let sitemapRoutes: string[] = []

      const outputSitemap = async () => {
        if (sitemapRoutes.length === 0)
          return

        const start = Date.now()
        const _routeRulesMatcher = toRouteMatcher(
          createRadixRouter({ routes: nitro.options.routeRules }),
        )
        const urlFilter = createFilter(config)
        const stream = new SitemapStream(config)

        const urls = sitemapRoutes
          // filter for config
          .filter(urlFilter)
          // fix order
          .sort()
          // check route rules
          .map((path) => {
            const routeRules = defu({}, ..._routeRulesMatcher.matchAll(path).reverse())
            // @ts-expect-error untyped
            if (routeRules.index === false)
              return false

            // @ts-expect-error untyped
            return { url: path, ...(routeRules.sitemap || {}) }
          }).filter(Boolean)

        const sitemapContext = { stream, urls }
        // @ts-expect-error untyped
        await nuxt.hooks.hook('sitemap:generate', sitemapContext)
        // Return a promise that resolves with your XML string
        const sitemapXml = await streamToPromise(Readable.from(sitemapContext.urls).pipe(sitemapContext.stream))
          .then(data => data.toString())

        await writeFile(resolve(nitro.options.output.publicDir, 'sitemap.xml'), sitemapXml)
        const generateTimeMS = Date.now() - start
        nitro.logger.log(chalk.gray(
          `  └─ /sitemap.xml (${generateTimeMS}ms)`,
        ))
        sitemapRoutes = []
      }

      nitro.hooks.hook('prerender:route', async ({ route }) => {
        // check if the route path is not for a file
        if (!route.includes('.'))
          sitemapRoutes.push(route)
      })

      // SSR mode
      nitro.hooks.hook('rollup:before', async () => {
        await outputSitemap()
      })

      // SSG mode
      nitro.hooks.hook('close', async () => {
        await outputSitemap()
      })
    })
  },
})
