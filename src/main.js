/**
 * Segugio.it Scraper v1.7.0
 *
 * Fixes:
 * - Try WITHOUT proxy first (Segugio may allow Apify datacenter IPs directly)
 * - If blocked, retry with RESIDENTIAL proxy
 * - waitUntil: 'commit' instead of 'domcontentloaded' (faster, less strict)
 * - Increased timeouts
 * - Abort image/font/css requests to speed up loading
 */

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce:       { urls: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`] },
    gas:        { urls: [`${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`] },
    'luce-gas': { urls: [`${BASE}/migliori-tariffe/migliori-tariffe-luce-gas.aspx`] },
    internet:   { urls: [`${BASE}/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx`] },
    mobile:     { urls: [`${BASE}/tariffe-cellulari/`] },
};

function parseEur(raw) {
    if (!raw) return null;
    const n = parseFloat(raw.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
}
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim() || null; }

const KNOWN_LABELS = new Set([
    'Nome offerta', 'Prezzo Luce', 'Prezzo Gas', 'Prezzo energia',
    'Quota fissa', 'Prezzo', 'Velocità', 'Tecnologia', 'GB inclusi', 'Minuti', 'SMS',
]);

function parseCardLines(lines) {
    const r = {
        nomeOfferta: null, prezzoCommodity: null, unitaCommodity: null,
        quotaFissa: null, quotaFissaEur: null, tipologiaPrezzo: null,
        prezzoMensile: null, prezzoMensileEur: null,
        bonus: null, sponsorizzata: false, esclusiva: false,
    };
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^\d[\d.,]* €$/.test(l) && lines[i + 1] === 'al mese') {
            r.prezzoMensile    = `${l} al mese`;
            r.prezzoMensileEur = parseEur(l);
        }
        if (/Annuncio sponsorizzato/i.test(l)) r.sponsorizzata = true;
        if (/Offerta esclusiva/i.test(l))      r.esclusiva     = true;
        if (KNOWN_LABELS.has(l) && i + 1 < lines.length) {
            const val = lines[i + 1];
            if (val && !KNOWN_LABELS.has(val) && val !== 'al mese' && val !== 'Altri dettagli') {
                if (l === 'Nome offerta') r.nomeOfferta = clean(val);
                if (['Prezzo Luce', 'Prezzo Gas', 'Prezzo energia'].includes(l)) {
                    r.prezzoCommodity = clean(val);
                    const um = val.match(/€\/(\w+)/);
                    r.unitaCommodity  = um ? `€/${um[1]}` : null;
                }
                if (l === 'Quota fissa') { r.quotaFissa = clean(val); r.quotaFissaEur = parseEur(val); }
                if (l === 'Prezzo' && !/€\//.test(val) && !/^\d,\d/.test(val)) r.tipologiaPrezzo = clean(val);
            }
        }
    }
    const bonusRx = [/^(Fino a .+)/i, /^(Sconto .+)/i, /^(Cashback .+)/i, /^(\d+€.+sconto.+)/i, /^(La nuova .+)/i, /^(\d+€\/mese .+)/i];
    for (const line of lines) {
        for (const rx of bonusRx) { const m = line.match(rx); if (m) { r.bonus = clean(m[1]); break; } }
        if (r.bonus) break;
    }
    return r;
}

async function createContext(browser, proxyUrl) {
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'it-IT',
        extraHTTPHeaders: {
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8',
            'Referer': 'https://www.segugio.it/',
        },
        ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    });

    // Block heavy resources to speed up loading
    await ctx.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf}', r => r.abort());
    await ctx.route('**/{analytics,gtm,facebook,google-analytics,hotjar}**', r => r.abort());

    return ctx;
}

async function tryNavigate(page, url) {
    // Try 'commit' first (fastest — just waits for response headers)
    try {
        const res = await page.goto(url, { waitUntil: 'commit', timeout: 25000 });
        return res;
    } catch (e) {
        log.warning(`commit failed (${e.message.slice(0,60)}), trying networkidle...`);
    }
    // Fallback: networkidle
    return await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
}

async function scrapePage(page, url, categoria, includeSponsored) {
    log.info(`━━━ [${categoria}] → ${url}`);

    const response = await tryNavigate(page, url);
    const status   = response?.status();
    const bodyLen  = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);
    log.info(`━━━ [${categoria}] HTTP ${status} | body: ${bodyLen} chars`);

    if (bodyLen < 500) {
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? '');
        log.warning(`━━━ [${categoria}] TINY BODY: "${bodyText}"`);
        return [];
    }

    // Check key selectors
    const checks = {
        'img[title^="Logo di "]':  await page.locator('img[title^="Logo di "]').count(),
        'img[alt^="logo "]':       await page.locator('img[alt^="logo "]').count(),
        '[class*="card"]':         await page.locator('[class*="card"]').count(),
        '[class*="offert"]':       await page.locator('[class*="offert"]').count(),
        'article':                 await page.locator('article').count(),
    };
    log.info(`━━━ [${categoria}] SELECTORS: ${JSON.stringify(checks)}`);

    // If no offers yet, wait and check SPA signals
    if (checks['img[title^="Logo di "]'] === 0) {
        log.info(`━━━ [${categoria}] Waiting for JS render (15s)...`);

        // Check if it's a SPA
        const spaSignals = await page.evaluate(() => ({
            nextData:  !!document.getElementById('__NEXT_DATA__'),
            reactRoot: !!document.getElementById('root') || !!document.getElementById('app'),
            bodyText200: document.body?.innerText?.slice(0, 200) ?? '',
            allImgTitles: [...document.querySelectorAll('img[title]')].slice(0,10).map(i => i.title),
            allImgAlts:   [...document.querySelectorAll('img[alt]')].slice(0,10).map(i => i.alt),
        }));
        log.info(`━━━ [${categoria}] SPA: ${JSON.stringify(spaSignals)}`);

        try {
            await page.waitForSelector('img[title^="Logo di "]', { timeout: 15000 });
            log.info(`━━━ [${categoria}] ✅ Offers rendered after wait`);
        } catch {
            // Scroll trigger
            await page.evaluate(() => window.scrollTo(0, 500));
            await page.waitForTimeout(3000);
            const c = await page.locator('img[title^="Logo di "]').count();
            log.info(`━━━ [${categoria}] After scroll: ${c} offer logos`);

            if (c === 0) {
                // Last resort: dump body text to diagnose
                const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '');
                log.info(`━━━ [${categoria}] BODY TEXT:\n${txt}`);
                return [];
            }
        }
    }

    // Extract
    const rawOffers = await page.evaluate(() => {
        const offers = [], seen = new Set();
        document.querySelectorAll('img[title^="Logo di "]').forEach(logoEl => {
            const fornitore = (logoEl.getAttribute('title') || '').replace(/^Logo di\s+/i, '').trim();
            if (!fornitore || seen.has(fornitore)) return;
            let card = logoEl.parentElement;
            for (let i = 0; i < 8; i++) {
                if ((card?.textContent || '').includes('al mese') || (card?.textContent || '').includes('Nome offerta')) break;
                card = card?.parentElement;
            }
            if (!card) return;
            let urlOfferta = null;
            card.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href') || '';
                if (/scopri|attiva/i.test(a.textContent) && href && href !== '#' && !href.includes('funzionamento'))
                    urlOfferta = href.startsWith('http') ? href : 'https://tariffe.segugio.it' + href;
            });
            const lines = (card.textContent || '').split(/\n/).map(l => l.trim()).filter(Boolean);
            seen.add(fornitore);
            offers.push({ fornitore, logoUrl: logoEl.getAttribute('src'), urlOfferta, lines });
        });
        return offers;
    });

    log.info(`━━━ [${categoria}] RAW OFFERS: ${rawOffers.length}`);
    if (rawOffers[0]) {
        log.info(`━━━ FIRST RAW: fornitore="${rawOffers[0].fornitore}" lines=${JSON.stringify(rawOffers[0].lines.slice(0, 15))}`);
    }

    const offers = [];
    for (const raw of rawOffers) {
        const p = parseCardLines(raw.lines);
        if (!p.prezzoMensileEur && !p.prezzoCommodity) continue;
        if (!includeSponsored && p.sponsorizzata) continue;
        offers.push({
            categoria, fornitore: raw.fornitore,
            nomeOfferta: p.nomeOfferta, prezzoMensile: p.prezzoMensile,
            prezzoMensileEur: p.prezzoMensileEur, prezzoCommodity: p.prezzoCommodity,
            unitaCommodity: p.unitaCommodity, quotaFissa: p.quotaFissa,
            quotaFissaEur: p.quotaFissaEur, tipologiaPrezzo: p.tipologiaPrezzo,
            durataContratto: p.tipologiaPrezzo?.match(/(\d+)\s*mesi/i)?.[1] ?? null,
            bonus: p.bonus, esclusiva: p.esclusiva, sponsorizzata: p.sponsorizzata,
            urlOfferta: raw.urlOfferta, logoFornitore: raw.logoUrl,
            fonte: url, scrapedAt: new Date().toISOString(),
        });
    }
    return offers;
}

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories       = ['luce'],
    includeSponsored = true,
    maxItems         = 0,
    proxyConfig: proxyConfigInput,
} = input;

// Build both proxy options: residential preferred, datacenter fallback, no-proxy last
let residentialProxyUrl, datacenterProxyUrl;
try {
    const proxyCfg = await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] });
    residentialProxyUrl = await proxyCfg.newUrl();
} catch { /* no residential access */ }
try {
    const proxyCfg = await Actor.createProxyConfiguration({ useApifyProxy: true });
    datacenterProxyUrl = await proxyCfg.newUrl();
} catch { /* no proxy */ }

log.info(`RESIDENTIAL proxy: ${residentialProxyUrl ? '✅' : '❌'}`);
log.info(`DATACENTER proxy:  ${datacenterProxyUrl  ? '✅' : '❌'}`);

const browser = await chromium.launch({
    headless: true,
    args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
    ],
});

// Try contexts in order: residential → datacenter → no proxy
const proxyOptions = [
    { label: 'RESIDENTIAL', url: residentialProxyUrl },
    { label: 'DATACENTER',  url: datacenterProxyUrl  },
    { label: 'NO PROXY',    url: undefined            },
];

let workingContext = null;
let workingProxyLabel = null;

for (const opt of proxyOptions) {
    log.info(`Testing proxy: ${opt.label}...`);
    const ctx  = await createContext(browser, opt.url);
    const page = await ctx.newPage();
    try {
        const res = await page.goto('https://tariffe.segugio.it/', { waitUntil: 'commit', timeout: 20000 });
        const status = res?.status();
        const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);
        log.info(`  → HTTP ${status} | body ${bodyLen} chars`);
        if (status === 200 && bodyLen > 1000) {
            log.info(`  ✅ ${opt.label} WORKS`);
            workingContext    = ctx;
            workingProxyLabel = opt.label;
            await page.close();
            break;
        }
    } catch (e) {
        log.warning(`  ❌ ${opt.label} failed: ${e.message.slice(0, 80)}`);
    }
    await page.close();
    await ctx.close();
}

if (!workingContext) {
    log.error('All proxy options failed — cannot reach segugio.it');
    await browser.close();
    await Actor.exit();
}

log.info(`Using proxy: ${workingProxyLabel}`);

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) continue;
    for (const url of def.urls) {
        const page = await workingContext.newPage();
        try {
            const offers = await scrapePage(page, url, cat, includeSponsored);
            log.info(`━━━ [${cat}] FINAL: ${offers.length} offers`);
            for (const offer of offers) {
                if (savedCount >= limit) break;
                const key = `${offer.fornitore}||${offer.nomeOfferta}||${cat}`;
                if (seenGlobal.has(key)) continue;
                seenGlobal.add(key);
                await dataset.pushData(offer);
                savedCount++;
                log.info(`  ✅ [${savedCount}] ${offer.fornitore} — ${offer.nomeOfferta} — €${offer.prezzoMensileEur}/mese`);
            }
        } catch (e) {
            log.error(`━━━ [${cat}] ERROR: ${e.message}`);
        } finally {
            await page.close();
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

await browser.close();
log.info(`━━━ DONE. Total saved: ${savedCount}`);
await Actor.exit();
