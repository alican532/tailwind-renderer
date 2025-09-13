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

app.get('/', (_req, res) => res.send('OK'));

const port = process.env.PORT || 3001;
app.listen(port, () => console.log('Renderer on :' + port));
