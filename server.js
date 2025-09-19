const express = require('express');
const { chromium } = require('playwright');
const { transform } = require('lightningcss');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Basit güvenlik için header token (Render ayarlarında vereceğiz)
const TOKEN = process.env.RENDER_TOKEN || '';

function buildShadowHtml(renderedHtml) {
  // 1) <body> içini al
  const bodyMatch = renderedHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let inner = bodyMatch ? bodyMatch[1] : renderedHtml;

  // Statik hedef: scriptleri temizle
  inner = inner.replace(/<script[\s\S]*?<\/script>/gi, '');

  // 2) Tüm <style> bloklarını topla (Tailwind Play CDN dahil)
  const styles = Array.from(renderedHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    .map(m => m[1])
    .join('\n');

  // 3) Shadow DOM iskeleti: CSS ve HTML'i shadow root içine gömecek
  const shell = `
<script>
(()=>{const TAG='myco-shadow-box';
if(!window.customElements.get(TAG)){
class MycoShadowBox extends HTMLElement{
  constructor(){
    super();
    const root = this.attachShadow({mode:'open'});
    const base = document.createElement('style');
    base.textContent = \`
:host{display:block;box-sizing:border-box}
\`;
    const cssT = this.querySelector(':scope > template.shadow-css');
    const htmlT = this.querySelector(':scope > template.shadow-html');
    const userCss = document.createElement('style');
    if (cssT){ userCss.textContent = cssT.content.textContent || ''; cssT.remove(); }
    let htmlFrag = document.createDocumentFragment();
    if (htmlT){ htmlFrag = htmlT.content.cloneNode(true); htmlT.remove(); }
    root.append(base, userCss, htmlFrag);
  }
}
customElements.define(TAG, MycoShadowBox);}
})();
</script>

<myco-shadow-box>
  <template class="shadow-css">/*__CSS__*/</template>
  <template class="shadow-html">__HTML__</template>
</myco-shadow-box>
`;

  return shell
    .replace('/*__CSS__*/', styles)
    .replace('__HTML__', inner);
}

app.post('/render', async (req, res) => {
  if (TOKEN && req.headers['x-render-token'] !== TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const raw = String(req.body.html || '');
  const doc = `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body>${raw}</body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: 'load' });
  await page.waitForTimeout(2000); // Tailwind Play için kısa bekleme
  const rendered = await page.content();
  await browser.close();

  const finalHtml = buildShadowHtml(rendered);
  res.json({ finalHtml });
});

app.post('/render-raw', async (req, res) => {
  if (TOKEN && req.headers['x-render-token'] !== TOKEN) {
    return res.status(401).send('unauthorized');
  }
  const raw = String(req.body.html || '');
  const doc = `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${raw}</body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(doc, { waitUntil: 'load' });
  await page.waitForTimeout(Number(process.env.RENDER_WAIT_MS || 2000));
  const rendered = await page.content();
  await browser.close();

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(rendered);
});

// server.js içine EK UÇ NOKTASI
// /render-css (BUILD'li, JSON döner; legacy=1 ile eski <style> çıktısı da desteklenir)
app.post('/render-css', async (req, res) => {
  try {
    if (TOKEN && req.headers['x-render-token'] !== TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const raw = String(req.body.html || '');
    const waitMs = Number(process.env.RENDER_WAIT_MS || 2000);

    // Parametreler
    const includeLinks = String(req.query.includeLinks ?? req.body.includeLinks ?? '').toLowerCase();
    const wantLinks = includeLinks === '1' || includeLinks === 'true';

    const includeRootVars = String(req.query.includeRootVars ?? req.body.includeRootVars ?? '').toLowerCase();
    const wantRootVars = includeRootVars === '1' || includeRootVars === 'true';

    const minifyFlag = String(req.query.minify ?? req.body.minify ?? '').toLowerCase();
    const doMinify = minifyFlag === '1' || minifyFlag === 'true';

    const legacyFlag = String(req.query.legacy ?? req.body.legacy ?? '').toLowerCase();
    const legacyHtml = legacyFlag === '1' || legacyFlag === 'true';

    // Render et (Tailwind/Play çalışsın)
    const doc = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body>${raw}</body></html>`;

    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(doc, { waitUntil: 'load' });
    await page.waitForTimeout(waitMs);
    const rendered = await page.content();
    await browser.close();

    // 1) Inline <style> blokları
    const inlineStyles = [];
    rendered.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
      inlineStyles.push(css);
      return '';
    });

    // 2) (opsiyonel) Harici CSS linklerini whitelist ile çek
    const wl = (process.env.CSS_LINK_WHITELIST || 'cdn.jsdelivr.net,fonts.googleapis.com')
      .split(',').map(s => s.trim()).filter(Boolean);

    async function pickAndFetchCssLinks(html) {
      const urls = new Set();
      html.replace(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi, (_, href) => {
        try {
          const u = new URL(href, 'https://example.base/');
          const host = u.hostname.replace(/^www\./,'');
          if (wl.some(w => host.endsWith(w))) urls.add(u.href);
        } catch {}
        return '';
      });

      const _fetch = global.fetch ? global.fetch.bind(global) : null;
      const out = [];
      for (const href of urls) {
        try {
          if (!_fetch) break; // Node <18 ise fetch yok (gerekirse node-fetch ekleyebilirsin)
          const r = await _fetch(href);
          if (r.ok) out.push(await r.text());
        } catch {}
      }
      return out;
    }

    const externalCss = wantLinks ? await pickAndFetchCssLinks(rendered) : [];
    const combinedCss = [...inlineStyles, ...externalCss].join('\n');

    // 3) @property bloklarını kopar
    const propertyBlocks = [];
    let cssNoProps = combinedCss.replace(/@property\s+[^{]+\{[\s\S]*?\}/g, (m) => {
      propertyBlocks.push(m);
      return '';
    });

    // (opsiyonel) :root{…} bloklarını da ayır
    const rootVarBlocks = [];
    if (wantRootVars) {
      cssNoProps = cssNoProps.replace(/:root\s*\{[\s\S]*?\}/g, (m) => {
        rootVarBlocks.push(m);
        return '';
      });
    }

    // 4) LightningCSS ile flatten/transpile (+minify)
    const out = transform({
      code: Buffer.from(cssNoProps, 'utf8'),
      drafts: { nesting: true, customMedia: true },
      targets: { chrome: 114 << 16, safari: 16 << 16, firefox: 102 << 16 },
      minify: !!doMinify,
    });
    const flatCss = new TextDecoder().decode(out.code);

    // 5) Yanıtı hazırla
    const cssRootProps = [...propertyBlocks, ...rootVarBlocks].join('\n').trim();
    const cssShadow = `<style>\n${flatCss}\n</style>`;

    if (legacyHtml) {
      // Eski tarz: text/html ile <style> blokları döndür
      const htmlOut = [
        cssShadow,
        cssRootProps ? `<style>\n${cssRootProps}\n</style>` : ''
      ].filter(Boolean).join('\n');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(htmlOut);
    }

    // Yeni: JSON
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.json({
      cssShadow,      // Shadow root'a koy
      cssRootProps,   // document.head'e enjekte et
      info: {
        includeLinks: !!wantLinks,
        includeRootVars: !!wantRootVars,
        minify: !!doMinify,
        waitMs
      }
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'render-css build error' });
  }
});

app.get('/', (_req, res) => res.send('OK'));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Renderer on :' + port));
