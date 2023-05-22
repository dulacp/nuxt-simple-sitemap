import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolveFiles, defineNuxtModule, createResolver, addTemplate, findPath, isIgnored, addServerHandler, addPrerenderRoutes, addServerPlugin, useLogger } from '@nuxt/kit';
import { defu } from 'defu';
import { toRouteMatcher, createRouter } from 'radix3';
import chalk from 'chalk';
import { encodePath, withBase, withoutTrailingSlash, joinURL, withTrailingSlash, withoutBase } from 'ufo';
import { globby } from 'globby';
import { relative, extname } from 'pathe';
import 'knitwork';
import escapeRE from 'escape-string-regexp';

function createFilter(options = {}) {
  const include = options.include || [];
  const exclude = options.exclude || [];
  if (include.length === 0 && exclude.length === 0)
    return () => true;
  return function(path) {
    for (const v of [{ rules: exclude, result: false }, { rules: include, result: true }]) {
      const regexRules = v.rules.filter((r) => r instanceof RegExp);
      if (regexRules.some((r) => r.test(path)))
        return v.result;
      const stringRules = v.rules.filter((r) => typeof r === "string");
      if (stringRules.length > 0) {
        const routes = {};
        for (const r of stringRules) {
          if (r === path)
            return v.result;
          routes[r] = true;
        }
        const routeRulesMatcher = toRouteMatcher(createRouter({ routes, ...options }));
        if (routeRulesMatcher.matchAll(path).length > 0)
          return Boolean(v.result);
      }
    }
    return include.length === 0;
  };
}

function mergeOnKey(arr, key) {
  const res = {};
  arr.forEach((item) => {
    const k = item[key];
    res[k] = defu(item, res[k] || {});
  });
  return Object.values(res);
}
async function resolvePagesRoutes(pagesDirs, extensions) {
  const allRoutes = await Promise.all(
    pagesDirs.map(async (dir) => {
      const files = await resolveFiles(dir, `**/*{${extensions.join(",")}}`);
      files.sort();
      return generateRoutesFromFiles(files, dir);
    })
  );
  return normalisePagesForSitemap(allRoutes.flat());
}
function unpackChildren(page) {
  if (!page.children)
    return [];
  return page.children.map((child) => {
    child.path = withBase(child.path, page.path);
    return [child, ...unpackChildren(child)];
  }).flat();
}
function normalisePagesForSitemap(allRoutes) {
  const pages = allRoutes.map((page) => {
    const pages2 = [page];
    pages2.push(...unpackChildren(page));
    return pages2;
  }).flat().filter((page) => !page.path.includes(":") && !page.path.includes("["));
  return mergeOnKey(pages, "path");
}
function generateRoutesFromFiles(files, pagesDir) {
  const routes = [];
  for (const file of files) {
    const segments = relative(pagesDir, file).replace(new RegExp(`${escapeRE(extname(file))}$`), "").split("/");
    const route = {
      name: "",
      path: "",
      file,
      children: []
    };
    let parent = routes;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const tokens = parseSegment(segment);
      const segmentName = tokens.map(({ value }) => value).join("");
      route.name += (route.name && "-") + segmentName;
      const child = parent.find((parentRoute) => parentRoute.name === route.name && !parentRoute.path.endsWith("(.*)*"));
      if (child && child.children) {
        parent = child.children;
        route.path = "";
      } else if (segmentName === "index" && !route.path) {
        route.path += "/";
      } else if (segmentName !== "index") {
        route.path += getRoutePath(tokens);
      }
    }
    parent.push(route);
  }
  return prepareRoutes(routes);
}
function getRoutePath(tokens) {
  return tokens.reduce((path, token) => {
    return path + (token.type === 2 /* optional */ ? `:${token.value}?` : token.type === 1 /* dynamic */ ? `:${token.value}` : token.type === 3 /* catchall */ ? `:${token.value}(.*)*` : encodePath(token.value));
  }, "/");
}
const PARAM_CHAR_RE = /[\w\d_.]/;
function parseSegment(segment) {
  let state = 0 /* initial */;
  let i = 0;
  let buffer = "";
  const tokens = [];
  function consumeBuffer() {
    if (!buffer)
      return;
    if (state === 0 /* initial */)
      throw new Error("wrong state");
    tokens.push({
      type: state === 1 /* static */ ? 0 /* static */ : state === 2 /* dynamic */ ? 1 /* dynamic */ : state === 3 /* optional */ ? 2 /* optional */ : 3 /* catchall */,
      value: buffer
    });
    buffer = "";
  }
  while (i < segment.length) {
    const c = segment[i];
    switch (state) {
      case 0 /* initial */:
        buffer = "";
        if (c === "[") {
          state = 2 /* dynamic */;
        } else {
          i--;
          state = 1 /* static */;
        }
        break;
      case 1 /* static */:
        if (c === "[") {
          consumeBuffer();
          state = 2 /* dynamic */;
        } else {
          buffer += c;
        }
        break;
      case 4 /* catchall */:
      case 2 /* dynamic */:
      case 3 /* optional */:
        if (buffer === "...") {
          buffer = "";
          state = 4 /* catchall */;
        }
        if (c === "[" && state === 2 /* dynamic */)
          state = 3 /* optional */;
        if (c === "]" && (state !== 3 /* optional */ || buffer[buffer.length - 1] === "]")) {
          if (!buffer)
            throw new Error("Empty param");
          else
            consumeBuffer();
          state = 0 /* initial */;
        } else if (PARAM_CHAR_RE.test(c)) {
          buffer += c;
        } else ;
        break;
    }
    i++;
  }
  if (state === 2 /* dynamic */)
    throw new Error(`Unfinished param "${buffer}"`);
  consumeBuffer();
  return tokens;
}
function prepareRoutes(routes, parent) {
  for (const route of routes) {
    if (route.name)
      route.name = route.name.replace(/-index$/, "");
    if (parent && route.path.startsWith("/"))
      route.path = route.path.slice(1);
    if (route.children?.length)
      route.children = prepareRoutes(route.children, route);
    if (route.children?.find((childRoute) => childRoute.path === ""))
      delete route.name;
  }
  return routes;
}

function normaliseDate(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  if (!(d instanceof Date))
    return false;
  const z = (n) => `0${n}`.slice(-2);
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}T${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}+00:00`;
}

async function generateSitemapEntries(options) {
  const {
    urls: configUrls,
    defaults,
    exclude,
    isNuxtContentDocumentDriven,
    include,
    trailingSlash,
    inferStaticPagesAsRoutes,
    hasApiRoutesUrl,
    autoLastmod,
    siteUrl,
    hasPrerenderedRoutesPayload,
    autoAlternativeLangPrefixes,
    dynamicUrlsApiEndpoint
  } = options.sitemapConfig;
  const baseURL = options.baseURL;
  const includeWithBase = include?.map((i) => withBase(i, baseURL));
  const excludeWithBase = exclude?.map((i) => withBase(i, baseURL));
  const urlFilter = createFilter({ include: includeWithBase, exclude: excludeWithBase });
  ({ ...defaults });
  const fixLoc = (url) => {
    url = encodeURI(trailingSlash ? withTrailingSlash(url) : withoutTrailingSlash(url));
    return url.startsWith(baseURL) ? url : withBase(url, baseURL);
  };
  function preNormalise(entries) {
    return mergeOnKey(
      entries.map((e) => typeof e === "string" ? { loc: e } : e).map((e) => ({ ...defaults, ...e })).map((e) => ({ ...e, loc: fixLoc(e.loc || e.url) })),
      "loc"
    ).filter((e) => urlFilter(e.loc)).sort((a, b) => a.loc.length - b.loc.length).map((e) => {
      delete e.url;
      if (e.lastmod)
        e.lastmod = normaliseDate(e.lastmod);
      if (!e.lastmod)
        delete e.lastmod;
      if (Array.isArray(autoAlternativeLangPrefixes)) {
        if (autoAlternativeLangPrefixes.some((prefix) => {
          return e.loc.startsWith(withBase(`/${prefix}`, options.baseURL));
        }))
          return false;
        const loc = e.loc?.replace(options.baseURL, "") || "";
        e.alternatives = autoAlternativeLangPrefixes.map((prefix) => ({
          hreflang: prefix,
          href: fixLoc(joinURL(prefix, loc))
        }));
      }
      return e;
    }).filter(Boolean);
  }
  function postNormalise(e) {
    const siteUrlWithoutBase = siteUrl.replace(new RegExp(`${baseURL}$`), "");
    e.loc = withBase(e.loc, siteUrlWithoutBase);
    return e;
  }
  let pageUrls = [];
  if (process.dev || process.env.prerender) {
    if (options.sitemapConfig.pagesDirs && options.sitemapConfig.extensions) {
      const { pagesDirs, extensions } = options.sitemapConfig;
      pageUrls = inferStaticPagesAsRoutes ? (await resolvePagesRoutes(pagesDirs, extensions)).map((page) => {
        const entry = { loc: page.path };
        if (autoLastmod && page.file) {
          const stats = statSync(page.file);
          entry.lastmod = stats.mtime;
        }
        return entry;
      }) : [];
    }
  }
  let lazyApiUrls = [];
  if (hasApiRoutesUrl) {
    lazyApiUrls = await globalThis.$fetch(dynamicUrlsApiEndpoint, {
      responseType: "json",
      baseURL: options.baseURL
    });
  }
  let prerenderedRoutesPayload = [];
  if (hasPrerenderedRoutesPayload) {
    let isHtmlResponse = false;
    const routes = await globalThis.$fetch("/__sitemap__/routes.json", {
      responseType: "json",
      headers: {
        Accept: "application/json"
      },
      // host is the actual web server being used
      baseURL: withBase(options.baseURL, options.sitemapConfig.host || siteUrl),
      onResponse({ response }) {
        if (typeof response._data === "string" && response._data.startsWith("<!DOCTYPE html>"))
          isHtmlResponse = true;
      }
    });
    if (!isHtmlResponse)
      prerenderedRoutesPayload = routes;
  }
  let nuxtContentUrls = [];
  if (isNuxtContentDocumentDriven) {
    nuxtContentUrls = await globalThis.$fetch("/api/__sitemap__/document-driven-urls", {
      responseType: "json",
      baseURL: options.baseURL
    });
  }
  const urls = [
    "/",
    ...prerenderedRoutesPayload,
    ...lazyApiUrls,
    ...configUrls,
    ...pageUrls,
    ...nuxtContentUrls
  ];
  return mergeOnKey(
    preNormalise(urls).map((entry) => {
      const routeRules = options.getRouteRulesForPath(withoutTrailingSlash(entry.loc));
      if (routeRules.index === false)
        return false;
      return defu(routeRules.sitemap, entry);
    }).filter(Boolean).map(postNormalise),
    "loc"
  );
}

function urlWithBase(url, base, siteUrl) {
  return joinURL(siteUrl.replace(new RegExp(`${base}$`), ""), base, url.replace(new RegExp(`^${base}`), ""));
}

const MaxSitemapSize = 1e3;
async function buildSitemapIndex(options) {
  const entries = [];
  const sitemapsConfig = options.sitemapConfig.sitemaps;
  const chunks = {};
  if (sitemapsConfig === true) {
    const urls = await generateSitemapEntries({
      ...options,
      sitemapConfig: { ...options.sitemapConfig }
    });
    urls.forEach((url, i) => {
      const chunkIndex = Math.floor(i / MaxSitemapSize);
      chunks[chunkIndex] = chunks[chunkIndex] || { urls: [] };
      chunks[chunkIndex].urls.push(url);
    });
  } else {
    for (const sitemap in sitemapsConfig) {
      if (sitemap !== "index") {
        chunks[sitemap] = chunks[sitemap] || { urls: [] };
        chunks[sitemap].urls = await generateSitemapEntries({
          ...options,
          sitemapConfig: { ...options.sitemapConfig, ...sitemapsConfig[sitemap] }
        });
      }
    }
  }
  for (const sitemap in chunks) {
    const entry = {
      sitemap: urlWithBase(`${sitemap}-sitemap.xml`, options.baseURL, options.sitemapConfig.siteUrl)
    };
    let lastmod = chunks[sitemap].urls.filter((a) => !!a?.lastmod).map((a) => typeof a.lastmod === "string" ? new Date(a.lastmod) : a.lastmod).sort((a, b) => b.getTime() - a.getTime())?.[0];
    if (!lastmod && options.sitemapConfig.autoLastmod)
      lastmod = /* @__PURE__ */ new Date();
    if (lastmod)
      entry.lastmod = normaliseDate(lastmod);
    entries.push(entry);
  }
  if (sitemapsConfig.index)
    entries.push(...sitemapsConfig.index);
  const sitemapXml = entries.map((e) => [
    "    <sitemap>",
    `        <loc>${normaliseValue("loc", e.sitemap, options)}</loc>`,
    // lastmod is optional
    e.lastmod ? `        <lastmod>${normaliseValue("lastmod", e.lastmod, options)}</lastmod>` : false,
    "    </sitemap>"
  ].filter(Boolean).join("\n")).join("\n");
  return {
    sitemaps: entries,
    xml: wrapSitemapXml([
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      sitemapXml,
      "</sitemapindex>"
    ], options.sitemapConfig.xsl)
  };
}
async function buildSitemap(options) {
  const sitemapsConfig = options.sitemapConfig.sitemaps;
  let urls = await generateSitemapEntries(options);
  if (sitemapsConfig === true)
    urls = urls.slice(Number(options.sitemapName) * MaxSitemapSize, (Number(options.sitemapName) + 1) * MaxSitemapSize);
  const ctx = { urls, sitemapName: options.sitemapName };
  await options.callHook?.(ctx);
  const resolveKey = (k) => {
    switch (k) {
      case "images":
        return "image";
      case "videos":
        return "video";
      default:
        return k;
    }
  };
  const handleArray = (key, arr) => {
    if (arr.length === 0)
      return false;
    key = resolveKey(key);
    if (key === "alternatives") {
      return arr.map((obj) => [
        `        <xhtml:link rel="alternate" ${Object.entries(obj).map(([sk, sv]) => `${sk}="${normaliseValue(sk, sv, options)}"`).join(" ")} />`
      ].join("\n")).join("\n");
    }
    return arr.map((obj) => [
      `        <${key}:${key}>`,
      ...Object.entries(obj).map(([sk, sv]) => `            <${key}:${sk}>${normaliseValue(sk, sv, options)}</${key}:${sk}>`),
      `        </${key}:${key}>`
    ].join("\n")).join("\n");
  };
  return wrapSitemapXml([
    '<urlset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd http://www.google.com/schemas/sitemap-image/1.1 http://www.google.com/schemas/sitemap-image/1.1/sitemap-image.xsd" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...ctx.urls?.map((e) => `    <url>
${Object.keys(e).map((k) => Array.isArray(e[k]) ? handleArray(k, e[k]) : `        <${k}>${normaliseValue(k, e[k], options)}</${k}>`).filter((l) => l !== false).join("\n")}
    </url>`) ?? [],
    "</urlset>"
  ], options.sitemapConfig.xsl);
}
function normaliseValue(key, value, options) {
  if (["loc", "href"].includes(key) && typeof value === "string") {
    if (value.startsWith("http://") || value.startsWith("https://"))
      return value;
    const url = urlWithBase(value, options.baseURL, options.sitemapConfig.siteUrl);
    if (url.includes("."))
      return url;
    return options.sitemapConfig.trailingSlash ? withTrailingSlash(url) : withoutTrailingSlash(url);
  }
  if (value instanceof Date)
    return normaliseDate(value);
  if (typeof value === "boolean")
    return value ? "yes" : "no";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function wrapSitemapXml(input, xsl) {
  input.unshift(`<?xml version="1.0" encoding="UTF-8"?>${xsl ? `<?xml-stylesheet type="text/xsl" href="${xsl}"?>` : ""}`);
  input.push("<!-- XML Sitemap generated by Nuxt Simple Sitemap -->");
  return input.join("\n");
}

const module = defineNuxtModule({
  meta: {
    name: "nuxt-simple-sitemap",
    compatibility: {
      nuxt: "^3.5.0",
      bridge: false
    },
    configKey: "sitemap"
  },
  defaults(nuxt) {
    const trailingSlash = process.env.NUXT_PUBLIC_TRAILING_SLASH || nuxt.options.runtimeConfig.public.trailingSlash;
    return {
      enabled: true,
      autoLastmod: true,
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || nuxt.options.runtimeConfig.public?.siteUrl,
      trailingSlash: String(trailingSlash) === "true",
      inferStaticPagesAsRoutes: true,
      discoverImages: true,
      dynamicUrlsApiEndpoint: "/api/_sitemap-urls",
      // index sitemap options filtering
      include: [],
      exclude: [],
      urls: [],
      sitemaps: false,
      xsl: "/__sitemap__/style.xsl",
      defaults: {}
    };
  },
  async setup(config, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    config.siteUrl = config.siteUrl || config.hostname;
    if (config.siteUrl && !config.siteUrl.startsWith("http"))
      config.siteUrl = `https://${config.siteUrl}`;
    nuxt.hooks.hook("robots:config", (robotsConfig) => {
      robotsConfig.sitemap.push(
        withBase(
          config.sitemaps ? "/sitemap_index.xml" : "/sitemap.xml",
          config.siteUrl
        )
      );
    });
    const nuxtI18nConfig = nuxt.options.i18n;
    if (nuxtI18nConfig?.pages) {
      config.inferStaticPagesAsRoutes = false;
      for (const pageLocales of Object.values(nuxtI18nConfig?.pages)) {
        for (const locale in pageLocales) {
          if (locale === nuxtI18nConfig?.defaultLocale && !pageLocales[locale].includes("[")) {
            const alternatives = Object.keys(pageLocales).filter((l) => l !== locale).map((l) => ({
              hreflang: l,
              href: nuxtI18nConfig?.strategy !== "no_prefix" ? joinURL(l, pageLocales[l]) : pageLocales[l]
            }));
            if (Array.isArray(config.urls)) {
              config.urls.push({
                loc: nuxtI18nConfig?.strategy === "prefix" ? joinURL(locale, pageLocales[locale]) : pageLocales[locale],
                alternatives
              });
            }
          }
        }
      }
    } else if (typeof config.autoAlternativeLangPrefixes === "undefined" && nuxtI18nConfig?.locales) {
      if (nuxtI18nConfig?.strategy !== "no_prefix") {
        const prefixes = [];
        nuxt.options.i18n.locales.forEach((locale) => {
          const loc = typeof locale === "string" ? locale : locale.code;
          if (loc === nuxtI18nConfig.defaultLocale)
            return;
          prefixes.push(loc);
        });
        config.autoAlternativeLangPrefixes = prefixes;
      }
    }
    addTemplate({
      filename: "nuxt-simple-sitemap.d.ts",
      getContents: () => {
        return `// Generated by nuxt-simple-sitemap
import type { SitemapItemDefaults } from 'nuxt-simple-sitemap'

interface NuxtSimpleSitemapNitroRules {
  index?: boolean
  sitemap?: SitemapItemDefaults
}
declare module 'nitropack' {
  interface NitroRouteRules extends NuxtSimpleSitemapNitroRules {}
  interface NitroRouteConfig extends NuxtSimpleSitemapNitroRules {}
}

export {}
`;
      }
    });
    nuxt.hooks.hook("prepare:types", ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, "nuxt-simple-sitemap.d.ts") });
    });
    let urls = [];
    if (typeof config.urls === "function")
      urls = [...await config.urls()];
    else if (Array.isArray(config.urls))
      urls = [...await config.urls];
    const hasApiRoutesUrl = !!await findPath(resolve(nuxt.options.serverDir, "api/_sitemap-urls")) || config.dynamicUrlsApiEndpoint !== "/api/_sitemap-urls";
    const isNuxtContentDocumentDriven = !!nuxt.options.content?.documentDriven || false;
    nuxt.hooks.hook("modules:done", async () => {
      const pagesDirs = nuxt.options._layers.map(
        (layer) => resolve(layer.config.srcDir, layer.config.dir?.pages || "pages")
      );
      if (nuxt.options.build) {
        let pagesRoutes = [];
        if (config.inferStaticPagesAsRoutes) {
          const allRoutes = (await Promise.all(
            pagesDirs.map(async (dir) => {
              const files = (await globby(`**/*{${nuxt.options.extensions.join(",")}}`, { cwd: dir, followSymbolicLinks: true })).map((p) => resolve(dir, p)).filter((p) => {
                if (isIgnored(p)) {
                  config.exclude = config.exclude || [];
                  config.exclude.push(generateRoutesFromFiles([p], dir)[0].path);
                  return false;
                }
                return true;
              }).sort();
              return generateRoutesFromFiles(files, dir);
            })
          )).flat();
          pagesRoutes = normalisePagesForSitemap(allRoutes).map((page) => {
            const entry = {
              loc: page.path
            };
            if (config.autoLastmod && page.file) {
              const stats = statSync(page.file);
              entry.lastmod = stats.mtime;
            }
            return entry;
          });
        }
        urls = [...urls, ...pagesRoutes];
      }
      const prerenderedRoutes2 = nuxt.options.nitro.prerender?.routes || [];
      const generateStaticSitemap2 = nuxt.options._generate || prerenderedRoutes2.includes("/sitemap.xml") || prerenderedRoutes2.includes("/sitemap_index.xml");
      nuxt.options.runtimeConfig["nuxt-simple-sitemap"] = {
        ...config,
        isNuxtContentDocumentDriven,
        hasApiRoutesUrl,
        urls,
        pagesDirs,
        hasPrerenderedRoutesPayload: !nuxt.options.dev && !generateStaticSitemap2,
        extensions: nuxt.options.extensions
      };
    });
    const prerenderedRoutes = nuxt.options.nitro.prerender?.routes || [];
    const generateStaticSitemap = !nuxt.options.dev && (nuxt.options._generate || prerenderedRoutes.includes("/sitemap.xml") || prerenderedRoutes.includes("/sitemap_index.xml"));
    if (config.xsl === "/__sitemap__/style.xsl") {
      addServerHandler({
        route: config.xsl,
        handler: resolve("./runtime/routes/sitemap.xsl")
      });
      config.xsl = withBase(config.xsl, nuxt.options.app.baseURL);
      if (generateStaticSitemap)
        addPrerenderRoutes(config.xsl);
    }
    if (config.sitemaps) {
      addServerHandler({
        route: "/sitemap_index.xml",
        handler: resolve("./runtime/routes/sitemap_index.xml")
      });
      addServerHandler({
        handler: resolve("./runtime/middleware/[sitemap]-sitemap.xml")
      });
    }
    addServerHandler({
      route: "/sitemap.xml",
      handler: resolve("./runtime/routes/sitemap.xml")
    });
    if (isNuxtContentDocumentDriven) {
      addServerPlugin(resolve("./runtime/plugins/nuxt-content"));
      addServerHandler({
        route: "/api/__sitemap__/document-driven-urls",
        handler: resolve("./runtime/routes/document-driven-urls")
      });
    }
    nuxt.hooks.hook("nitro:init", async (nitro) => {
      const logger = useLogger("nuxt-simple-sitemap");
      if (!config.enabled) {
        logger.debug("Sitemap generation is disabled.");
        return;
      }
      const sitemapImages = {};
      nitro.hooks.hook("prerender:route", async (ctx) => {
        const html = ctx.contents;
        if (ctx.fileName?.endsWith(".html") && html) {
          const mainRegex = /<main[^>]*>([\s\S]*?)<\/main>/;
          const mainMatch = mainRegex.exec(html);
          if (!mainMatch || !mainMatch[1])
            return;
          if (config.discoverImages && mainMatch[1].includes("<img")) {
            const imgRegex = /<img[^>]+src="([^">]+)"/g;
            let match;
            while ((match = imgRegex.exec(mainMatch[1])) !== null) {
              if (match.index === imgRegex.lastIndex)
                imgRegex.lastIndex++;
              const url = new URL(match[1], config.siteUrl);
              sitemapImages[ctx.route] = sitemapImages[ctx.route] || [];
              sitemapImages[ctx.route].push({
                loc: url.href
              });
            }
          }
        }
      });
      let sitemapGenerated = false;
      const outputSitemap = async () => {
        if (sitemapGenerated || nuxt.options.dev || nuxt.options._prepare)
          return;
        const prerenderRoutes = nitro._prerenderedRoutes?.filter((r) => !r.route.includes(".")).map((r) => ({ url: r.route })) || [];
        const configUrls = [...new Set([...prerenderRoutes, ...urls].map((r) => typeof r === "string" ? r : r.url || r.loc))];
        if (!generateStaticSitemap) {
          await mkdir(resolve(nitro.options.output.publicDir, "__sitemap__"), { recursive: true });
          await writeFile(resolve(nitro.options.output.publicDir, "__sitemap__/routes.json"), JSON.stringify(configUrls));
          nitro.logger.log(chalk.gray(
            "  \u251C\u2500 /__sitemap__/routes.json (0ms)"
          ));
          return;
        }
        sitemapGenerated = true;
        if (!config.siteUrl) {
          logger.error("Please set a `siteUrl` on the `sitemap` config to use `nuxt-simple-sitemap`.");
          return;
        }
        let start = Date.now();
        const _routeRulesMatcher = toRouteMatcher(
          createRouter({ routes: nitro.options.routeRules })
        );
        const routeMatcher = (path) => {
          const matchedRoutes = _routeRulesMatcher.matchAll(withoutBase(withoutTrailingSlash(path), nuxt.options.app.baseURL)).reverse();
          if (sitemapImages[path]) {
            matchedRoutes.push({
              sitemap: {
                images: sitemapImages[path]
              }
            });
          }
          return defu({}, ...matchedRoutes);
        };
        const callHook = async (ctx) => {
          await nuxt.hooks.callHook("sitemap:generate", ctx);
          await nuxt.hooks.callHook("sitemap:prerender", ctx);
        };
        const sitemapConfig = {
          ...config,
          hasApiRoutesUrl,
          isNuxtContentDocumentDriven,
          urls: configUrls,
          hasPrerenderedRoutesPayload: !generateStaticSitemap
        };
        if (process.dev || process.env.prerender) {
          sitemapConfig.pagesDirs = nuxt.options._layers.map(
            (layer) => resolve(layer.config.srcDir, layer.config.dir?.pages || "pages")
          );
          sitemapConfig.extensions = nuxt.options.extensions;
        }
        if (config.sitemaps) {
          start = Date.now();
          const { xml, sitemaps } = await buildSitemapIndex({
            sitemapConfig,
            baseURL: nuxt.options.app.baseURL,
            getRouteRulesForPath: routeMatcher,
            callHook
          });
          await writeFile(resolve(nitro.options.output.publicDir, "sitemap_index.xml"), xml);
          const generateTimeMS = Date.now() - start;
          nitro.logger.log(chalk.gray(
            `  \u251C\u2500 /sitemap_index.xml (${generateTimeMS}ms)`
          ));
          let sitemapNames = Object.keys(config.sitemaps);
          if (config.sitemaps === true)
            sitemapNames = sitemaps.map((s) => s.sitemap.split("/").pop()?.replace("-sitemap.xml", "")).filter(Boolean);
          for (const sitemap of sitemapNames) {
            const sitemapXml = await buildSitemap({
              sitemapName: sitemap,
              // @ts-expect-error untyped
              sitemapConfig: { ...defu(sitemapConfig.sitemaps[sitemap], sitemapConfig), urls: configUrls },
              baseURL: nuxt.options.app.baseURL,
              getRouteRulesForPath: routeMatcher,
              callHook
            });
            await writeFile(resolve(nitro.options.output.publicDir, `${sitemap}-sitemap.xml`), sitemapXml);
            const generateTimeMS2 = Date.now() - start;
            const isLastEntry = Object.keys(config.sitemaps).indexOf(sitemap) === Object.keys(config.sitemaps).length - 1;
            nitro.logger.log(chalk.gray(
              `  ${isLastEntry ? "\u2514\u2500" : "\u251C\u2500"} /${sitemap}-sitemap.xml (${generateTimeMS2}ms)`
            ));
          }
        } else {
          const sitemapXml = await buildSitemap({
            sitemapName: "sitemap",
            sitemapConfig,
            baseURL: nuxt.options.app.baseURL,
            getRouteRulesForPath: routeMatcher,
            callHook
          });
          await writeFile(resolve(nitro.options.output.publicDir, "sitemap.xml"), sitemapXml);
          const generateTimeMS = Date.now() - start;
          nitro.logger.log(chalk.gray(
            `  \u2514\u2500 /sitemap.xml (${generateTimeMS}ms)`
          ));
        }
      };
      nitro.hooks.hook("rollup:before", async () => {
        await outputSitemap();
      });
      nitro.hooks.hook("close", async () => {
        await outputSitemap();
      });
    });
  }
});

export { module as default };
