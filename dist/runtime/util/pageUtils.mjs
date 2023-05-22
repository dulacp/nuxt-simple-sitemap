import { extname, normalize, relative } from "pathe";
import { encodePath, withBase } from "ufo";
import { resolveFiles } from "@nuxt/kit";
import { genArrayFromRaw, genDynamicImport, genImport, genSafeVariableName } from "knitwork";
import escapeRE from "escape-string-regexp";
import { defu } from "defu";
var SegmentParserState = /* @__PURE__ */ ((SegmentParserState2) => {
  SegmentParserState2[SegmentParserState2["initial"] = 0] = "initial";
  SegmentParserState2[SegmentParserState2["static"] = 1] = "static";
  SegmentParserState2[SegmentParserState2["dynamic"] = 2] = "dynamic";
  SegmentParserState2[SegmentParserState2["optional"] = 3] = "optional";
  SegmentParserState2[SegmentParserState2["catchall"] = 4] = "catchall";
  return SegmentParserState2;
})(SegmentParserState || {});
var SegmentTokenType = /* @__PURE__ */ ((SegmentTokenType2) => {
  SegmentTokenType2[SegmentTokenType2["static"] = 0] = "static";
  SegmentTokenType2[SegmentTokenType2["dynamic"] = 1] = "dynamic";
  SegmentTokenType2[SegmentTokenType2["optional"] = 2] = "optional";
  SegmentTokenType2[SegmentTokenType2["catchall"] = 3] = "catchall";
  return SegmentTokenType2;
})(SegmentTokenType || {});
export function mergeOnKey(arr, key) {
  const res = {};
  arr.forEach((item) => {
    const k = item[key];
    res[k] = defu(item, res[k] || {});
  });
  return Object.values(res);
}
export async function resolvePagesRoutes(pagesDirs, extensions) {
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
export function normalisePagesForSitemap(allRoutes) {
  const pages = allRoutes.map((page) => {
    const pages2 = [page];
    pages2.push(...unpackChildren(page));
    return pages2;
  }).flat().filter((page) => !page.path.includes(":") && !page.path.includes("["));
  return mergeOnKey(pages, "path");
}
export function generateRoutesFromFiles(files, pagesDir) {
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
        } else {
        }
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
export function normalizeRoutes(routes, metaImports = /* @__PURE__ */ new Set()) {
  return {
    imports: metaImports,
    routes: genArrayFromRaw(routes.map((route) => {
      const file = normalize(route.file);
      const metaImportName = `${genSafeVariableName(file)}Meta`;
      metaImports.add(genImport(`${file}?macro=true`, [{ name: "default", as: metaImportName }]));
      let aliasCode = `${metaImportName}?.alias || []`;
      if (Array.isArray(route.alias) && route.alias.length)
        aliasCode = `${JSON.stringify(route.alias)}.concat(${aliasCode})`;
      return {
        ...Object.fromEntries(Object.entries(route).map(([key, value]) => [key, JSON.stringify(value)])),
        name: `${metaImportName}?.name ?? ${route.name ? JSON.stringify(route.name) : "undefined"}`,
        path: `${metaImportName}?.path ?? ${JSON.stringify(route.path)}`,
        children: route.children ? normalizeRoutes(route.children, metaImports).routes : [],
        meta: route.meta ? `{...(${metaImportName} || {}), ...${JSON.stringify(route.meta)}}` : metaImportName,
        alias: aliasCode,
        redirect: route.redirect ? JSON.stringify(route.redirect) : `${metaImportName}?.redirect || undefined`,
        component: genDynamicImport(file, { interopDefault: true })
      };
    }))
  };
}
