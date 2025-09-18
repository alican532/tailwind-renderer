const express = require('express');
const { chromium } = require('playwright');

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
app.post('/render-css', async (req, res) => {
  try {
    if (TOKEN && req.headers['x-render-token'] !== TOKEN) {
      return res.status(401).send('unauthorized');
    }
    const raw = String(req.body.html || '');
    // Opsiyonel: harici CSS linklerini da dahil et (1/true -> dahil)
    const includeLinks = String(req.query.includeLinks || req.body.includeLinks || '').toLowerCase();
    const wantLinks = includeLinks === '1' || includeLinks === 'true';

    const doc = `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body>${raw}</body></html>`;

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(doc, { waitUntil: 'load' });
    await page.waitForTimeout(Number(process.env.RENDER_WAIT_MS || 2000)); // Tailwind/diğerleri için bekleme
    const rendered = await page.content();
    await browser.close();

    // 1) Tüm inline <style> bloklarını topla (Tailwind çıktısı dahil)
    const styleBlocks = [];
    rendered.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
      styleBlocks.push(css);
      return '';
    });

    // 2) (Opsiyonel) Harici CSS linklerini whitelist ile al ve <style> içine göm
    // Whitelist'i env ile override edebilirsin: CSS_LINK_WHITELIST="cdn.jsdelivr.net,fonts.googleapis.com"
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
      // Node 18+ global fetch
      const out = [];
      for (const href of urls) {
        try {
          const r = await fetch(href);
          if (r.ok) {
            const txt = await r.text();
            out.push(txt);
          }
        } catch { /* ignore individual failures */ }
      }
      return out;
    }

    if (wantLinks) {
      const externalCss = await pickAndFetchCssLinks(rendered);
      for (const css of externalCss) styleBlocks.push(css);
    }

    // 3) Yanıt: <style> bloklarını birleştirip döndür
    // (İstersen minify ekleyebilirsin; burada raw bırakıyoruz)
    const htmlOut = styleBlocks.map(css => `<style>\n${css}\n</style>`).join('\n');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlOut);
  } catch (e) {
    console.error(e);
    res.status(500).send('render-css error');
  }
});

app.get('/', (_req, res) => res.send('OK'));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Renderer on :' + port));
