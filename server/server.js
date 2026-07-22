'use strict';

const compression = require('compression');
const cors = require('cors');
const dns = require('node:dns').promises;
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const ipaddr = require('ipaddr.js');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 3210);
const API_KEY = String(process.env.API_KEY || '').trim();
const MAX_CONCURRENT_RENDERS = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS || 1));
const NAVIGATION_TIMEOUT_MS = 55_000;
const TOTAL_RENDER_TIMEOUT_MS = 210_000;
const MAX_HTML_BYTES = 14 * 1024 * 1024;
const MAX_INLINE_ASSET_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_INLINE_BYTES = 36 * 1024 * 1024;
const MAX_INLINE_IMAGES = 90;
const MAX_INLINE_BACKGROUNDS = 70;
const HOST_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_IP_RANGE = 'unicast';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-API-Key'] }));
app.use(compression());
app.use(express.json({ limit: '1mb', strict: true }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (request) => request.path === '/' || request.path === '/healthz',
  message: { ok: false, error: 'Too many requests. Wait a few minutes and try again.' },
}));

let browserPromise = null;
const hostCache = new Map();
const waitQueue = [];
let activeRenders = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return;
  }
  await new Promise((resolve) => waitQueue.push(resolve));
  activeRenders += 1;
}

function releaseRenderSlot() {
  activeRenders = Math.max(0, activeRenders - 1);
  const next = waitQueue.shift();
  if (next) next();
}

function stripIpv6Brackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

function isBlockedHostName(hostname) {
  const host = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  return !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal';
}

function isPublicIp(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(address));
  } catch (_error) {
    return false;
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
  return parsed.range() === PUBLIC_IP_RANGE;
}

async function assertPublicHostname(hostname) {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (isBlockedHostName(host)) throw new Error('Local and private network addresses are not allowed.');

  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.checkedAt < HOST_CACHE_TTL_MS) {
    if (!cached.allowed) throw new Error('This address resolves to a private or reserved network.');
    return;
  }

  if (ipaddr.isValid(host)) {
    const allowed = isPublicIp(host);
    hostCache.set(host, { allowed, checkedAt: Date.now() });
    if (!allowed) throw new Error('Private and reserved IP addresses are not allowed.');
    return;
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (_error) {
    throw new Error('The website address could not be resolved.');
  }
  const allowed = records.length > 0 && records.every((record) => isPublicIp(record.address));
  hostCache.set(host, { allowed, checkedAt: Date.now() });
  if (!allowed) throw new Error('This address resolves to a private or reserved network.');
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_error) {
    throw new Error('Enter a complete website URL, such as https://example.com.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http:// and https:// URLs are allowed.');
  if (parsed.username || parsed.password) throw new Error('URLs containing a username or password are not allowed.');
  await assertPublicHostname(parsed.hostname);
  return parsed.href;
}

async function launchChromium() {
  const launchOptions = {
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--no-first-run',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
  };
  try {
    return await chromium.launch({ ...launchOptions, chromiumSandbox: true });
  } catch (error) {
    console.warn('Chromium sandbox was unavailable; falling back to container isolation.', error instanceof Error ? error.message : String(error));
    return chromium.launch({ ...launchOptions, chromiumSandbox: false });
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchChromium().then((browser) => {
      browser.on('disconnected', () => { browserPromise = null; });
      return browser;
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
}

async function autoScroll(page) {
  return page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const viewport = Math.max(500, window.innerHeight || 900);
    const step = Math.max(320, Math.floor(viewport * 0.72));
    let y = 0;
    let stableRounds = 0;
    let previousHeight = 0;
    let steps = 0;
    while (steps < 120 && y < 100000) {
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      window.scrollTo(0, Math.min(y, height));
      window.dispatchEvent(new Event('scroll'));
      await delay(100);
      const nextHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      stableRounds = nextHeight === previousHeight ? stableRounds + 1 : 0;
      previousHeight = nextHeight;
      y += step;
      steps += 1;
      if (y >= nextHeight && stableRounds >= 4) break;
    }
    window.scrollTo(0, 0);
    return { steps, height: previousHeight };
  });
}

function responseToDataUrl(contentType, buffer) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) return null;
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function fetchPublicImage(url, referer, userAgent) {
  const safeUrl = await assertPublicUrl(url);
  let current = safeUrl;
  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          'Referer': referer,
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        current = await assertPublicUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) return null;
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > MAX_INLINE_ASSET_BYTES) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_INLINE_ASSET_BYTES) return null;
      return responseToDataUrl(response.headers.get('content-type'), buffer);
    } catch (_error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function inlineImages(page, referer, userAgent, warnings) {
  const images = await page.evaluate((limit) => {
    const result = [];
    for (const image of Array.from(document.images)) {
      if (result.length >= limit) break;
      const rect = image.getBoundingClientRect();
      const source = image.currentSrc || image.src;
      if (!source || source.startsWith('data:') || source.startsWith('blob:') || rect.width <= 0 || rect.height <= 0) continue;
      const id = `h2f-image-${result.length}`;
      image.setAttribute('data-h2f-image-id', id);
      result.push({ id, source });
    }
    return result;
  }, MAX_INLINE_IMAGES);

  const cache = new Map();
  let totalBytes = 0;
  let failures = 0;
  let screenshotFallbacks = 0;
  for (const item of images) {
    let dataUrl = cache.get(item.source);
    if (dataUrl === undefined) {
      dataUrl = await fetchPublicImage(item.source, referer, userAgent);
      cache.set(item.source, dataUrl);
    }
    if (!dataUrl && screenshotFallbacks < 25) {
      try {
        const bytes = await page.locator(`[data-h2f-image-id="${item.id}"]`).screenshot({ type: 'png', animations: 'disabled', timeout: 8_000 });
        dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
        screenshotFallbacks += 1;
      } catch (_error) {}
    }
    if (!dataUrl) {
      failures += 1;
      continue;
    }
    totalBytes += Buffer.byteLength(dataUrl, 'utf8');
    if (totalBytes > MAX_TOTAL_INLINE_BYTES) {
      warnings.push('Some images were left external because the page contains too much image data.');
      break;
    }
    await page.evaluate(({ id, dataUrl: value }) => {
      const image = document.querySelector(`[data-h2f-image-id="${id}"]`);
      if (!image) return;
      image.src = value;
      image.srcset = '';
      image.removeAttribute('loading');
      image.removeAttribute('data-h2f-image-id');
    }, { id: item.id, dataUrl });
  }
  if (failures) warnings.push(`${failures} image(s) could not be embedded and may be missing in Figma.`);
}

async function inlineBackgroundImages(page, referer, userAgent, warnings) {
  const entries = await page.evaluate((limit) => {
    const output = [];
    const urlPattern = /url\((['"]?)(.*?)\1\)/g;
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      if (output.length >= limit) break;
      const style = getComputedStyle(element);
      const backgroundImage = style.backgroundImage;
      if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url(')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const urls = [];
      let match;
      while ((match = urlPattern.exec(backgroundImage))) {
        const raw = match[2];
        if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) continue;
        try { urls.push(new URL(raw, document.baseURI).href); } catch (_error) {}
      }
      if (!urls.length) continue;
      const id = `h2f-bg-${output.length}`;
      element.setAttribute('data-h2f-bg-id', id);
      output.push({ id, backgroundImage, urls });
    }
    return output;
  }, MAX_INLINE_BACKGROUNDS);

  const cache = new Map();
  let failed = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const replacements = {};
    for (const url of entry.urls) {
      let dataUrl = cache.get(url);
      if (dataUrl === undefined) {
        dataUrl = await fetchPublicImage(url, referer, userAgent);
        cache.set(url, dataUrl);
      }
      if (dataUrl) {
        totalBytes += Buffer.byteLength(dataUrl, 'utf8');
        if (totalBytes <= MAX_TOTAL_INLINE_BYTES) replacements[url] = dataUrl;
      } else {
        failed += 1;
      }
    }
    await page.evaluate(({ id, replacements: map }) => {
      const element = document.querySelector(`[data-h2f-bg-id="${id}"]`);
      if (!element) return;
      let value = getComputedStyle(element).backgroundImage;
      for (const [url, dataUrl] of Object.entries(map)) value = value.split(url).join(dataUrl);
      element.style.backgroundImage = value;
      element.removeAttribute('data-h2f-bg-id');
    }, { id: entry.id, replacements });
  }
  if (failed) warnings.push('Some CSS background images could not be embedded.');
}

async function replaceRenderedSurfaces(page, warnings) {
  const selectors = ['canvas', 'iframe'];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), selector === 'canvas' ? 25 : 8);
    for (let index = count - 1; index >= 0; index -= 1) {
      const item = locator.nth(index);
      try {
        const box = await item.boundingBox();
        if (!box || box.width <= 1 || box.height <= 1) continue;
        const bytes = await item.screenshot({ type: 'png', animations: 'disabled', timeout: 8_000 });
        const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
        await item.evaluate((element, value) => {
          const image = document.createElement('img');
          image.src = value;
          image.alt = element.getAttribute('title') || element.getAttribute('aria-label') || '';
          image.setAttribute('style', element.getAttribute('style') || '');
          image.style.width = `${element.getBoundingClientRect().width}px`;
          image.style.height = `${element.getBoundingClientRect().height}px`;
          image.style.display = getComputedStyle(element).display === 'inline' ? 'inline-block' : getComputedStyle(element).display;
          element.replaceWith(image);
        }, dataUrl);
      } catch (_error) {
        warnings.push(`A ${selector} element could not be captured.`);
      }
    }
  }
}

async function prepareSnapshot(page, finalUrl) {
  return page.evaluate(({ baseUrl }) => {
    document.querySelectorAll('base').forEach((node) => node.remove());
    const base = document.createElement('base');
    base.href = baseUrl;
    (document.head || document.documentElement).prepend(base);

    document.querySelectorAll('script,noscript,meta[http-equiv="Content-Security-Policy"],link[rel="preload"],link[rel="modulepreload"]').forEach((node) => node.remove());
    for (const element of Array.from(document.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes || [])) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    }

    for (const input of Array.from(document.querySelectorAll('input'))) {
      if (input.type === 'checkbox' || input.type === 'radio') {
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
      } else {
        input.setAttribute('value', input.value || '');
      }
    }
    for (const textarea of Array.from(document.querySelectorAll('textarea'))) textarea.textContent = textarea.value || '';
    for (const option of Array.from(document.querySelectorAll('option'))) {
      if (option.selected) option.setAttribute('selected', '');
      else option.removeAttribute('selected');
    }

    const freeze = document.createElement('style');
    freeze.setAttribute('data-html-to-figma-freeze', '');
    freeze.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';
    (document.head || document.documentElement).appendChild(freeze);
    window.scrollTo(0, 0);
    return {
      title: document.title || '',
      height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    };
  }, { baseUrl: finalUrl });
}

async function renderWebsite(rawUrl, width) {
  const safeUrl = await assertPublicUrl(rawUrl);
  const browser = await getBrowser();
  const warnings = [];
  const viewportWidth = Math.max(320, Math.min(3840, Math.round(Number(width) || 1440)));
  const viewportHeight = viewportWidth >= 1600 ? 1080 : viewportWidth >= 1000 ? 900 : viewportWidth >= 600 ? 1024 : 844;
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 HTMLToFigma/2.7';

  const context = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    deviceScaleFactor: 1,
    userAgent,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  page.setDefaultTimeout(20_000);
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (/^(data|blob|about):/i.test(requestUrl)) return route.continue();
    try {
      await assertPublicUrl(requestUrl);
      return route.continue();
    } catch (_error) {
      return route.abort('blockedbyclient');
    }
  });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && consoleErrors.length < 4) consoleErrors.push(message.text().slice(0, 180));
  });
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

  try {
    const response = await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    if (!response) throw new Error('The website did not return a page.');
    if (response.status() >= 400) throw new Error(`The website returned HTTP ${response.status()}.`);
    const finalUrl = await assertPublicUrl(page.url());

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => warnings.push('The page kept loading background requests, so the importer continued after a timeout.'));
    const scrollResult = await autoScroll(page);
    await sleep(700);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.evaluate(async () => {
      try { await document.fonts?.ready; } catch (_error) {}
      await Promise.all(Array.from(document.images).map((image) => image.decode?.().catch(() => {})));
    }).catch(() => {});

    if (scrollResult.steps >= 120) warnings.push('The page is very long or uses infinite scrolling; only the loaded portion was imported.');
    await replaceRenderedSurfaces(page, warnings);
    await inlineImages(page, finalUrl, userAgent, warnings);
    await inlineBackgroundImages(page, finalUrl, userAgent, warnings);
    const snapshot = await prepareSnapshot(page, finalUrl);
    if (consoleErrors.length) warnings.push('The page reported browser errors; some dynamic widgets may be incomplete.');

    const html = await page.content();
    const htmlSize = Buffer.byteLength(html, 'utf8');
    if (htmlSize > MAX_HTML_BYTES) throw new Error('This page is too large to send to the plugin. Try a smaller page.');

    return {
      ok: true,
      sourceName: snapshot.title || new URL(finalUrl).hostname,
      title: snapshot.title,
      finalUrl,
      width: viewportWidth,
      height: snapshot.height,
      html,
      warnings: Array.from(new Set(warnings)),
    };
  } finally {
    await context.close().catch(() => {});
  }
}


function requireApiKey(request, response, next) {
  if (!API_KEY) {
    response.status(503).json({ ok: false, error: 'API_KEY is not configured on the server.' });
    return;
  }
  const provided = String(request.get('X-API-Key') || '');
  if (provided.length !== API_KEY.length || !require('node:crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY))) {
    response.status(401).json({ ok: false, error: 'Invalid server key.' });
    return;
  }
  next();
}

app.get('/', (_request, response) => {
  response.type('html').send('<!doctype html><meta charset="utf-8"><title>HTML to Figma server</title><style>body{font:16px system-ui;margin:40px;max-width:720px}code{background:#f2f3f5;padding:2px 6px;border-radius:5px}</style><h1>HTML to Figma server is running</h1><p>The service is ready for the Figma plugin. Website rendering is requested by the Figma plugin.</p>');
});

app.get('/healthz', (_request, response) => {
  response.json({ ok: true, service: 'html-to-figma-render-server' });
});

app.get('/health', requireApiKey, async (_request, response) => {
  try {
    const browser = await Promise.race([
      getBrowser(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Browser startup timeout.')), 35_000)),
    ]);
    response.json({ ok: true, browserReady: browser.isConnected(), activeRenders, queuedRenders: waitQueue.length });
  } catch (error) {
    response.status(503).json({ ok: false, browserReady: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/render', requireApiKey, async (request, response) => {
  response.setTimeout(TOTAL_RENDER_TIMEOUT_MS + 15_000);
  const startedAt = Date.now();
  await acquireRenderSlot();
  try {
    const result = await Promise.race([
      renderWebsite(request.body?.url, request.body?.width),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Rendering took too long. Try a simpler page.')), TOTAL_RENDER_TIMEOUT_MS)),
    ]);
    response.json({ ...result, durationMs: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /URL|address|private|reserved|allowed|resolved/i.test(message) ? 400 : 502;
    response.status(status).json({ ok: false, error: message });
  } finally {
    releaseRenderSlot();
  }
});

app.use((_request, response) => response.status(404).json({ ok: false, error: 'Not found.' }));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ ok: false, error: 'Unexpected server error.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HTML to Figma render server listening on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close();
  try {
    const browser = browserPromise ? await browserPromise : null;
    await browser?.close();
  } catch (_error) {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
