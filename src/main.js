/**
 * Segugio.it Scraper v1.6.0 — diagnostic build
 *
 * Heavy logging to diagnose page structure and fix selectors.
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

async function scrapePage(page, url, categoria, includeSponsored) {
    log.info(`━━━ [${categoria}] NAVIGATING: ${url}`);

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status   = response?.status();
    log.info(`━━━ [${categoria}] HTTP STATUS: ${status}`);

    // ── DIAGNOSTIC 1: page title and basic info
    const title  = await page.title();
    const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);
    log.info(`━━━ [${categoria}] PAGE TITLE: "${title}" | BODY HTML LENGTH: ${bodyLen}`);

    // ── DIAGNOSTIC 2: wait strategy — try multiple selectors
    const selectors = [
        'img[title^="Logo di "]',
        'img[alt^="logo "]',
        'img[alt^="Logo "]',
        '[class*="card"]',
        '[class*="offer"]',
        '[class*="offerta"]',
        '[class*="tariffa"]',
        '[class*="provider"]',
        '[class*="fornitore"]',
        'article',
    ];

    log.info(`━━━ [${categoria}] CHECKING SELECTORS...`);
    for (const sel of selectors) {
        const count = await page.locator(sel).count();
        if (count > 0) log.info(`  ✅ "${sel}" → ${count} elements`);
        else           log.info(`  ❌ "${sel}" → 0`);
    }

    // ── DIAGNOSTIC 3: wait for content or timeout
    let rendered = false;
    try {
        await page.waitForSelector('img[title^="Logo di "]', { timeout: 15000 });
        rendered = true;
        log.info(`━━━ [${categoria}] ✅ img[title^="Logo di "] appeared`);
    } catch {
        log.warning(`━━━ [${categoria}] ⚠️  img[title^="Logo di "] did NOT appear — trying scroll + wait`);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await page.waitForTimeout(3000);
        const countAfter = await page.locator('img[title^="Logo di "]').count();
        log.info(`━━━ [${categoria}] After scroll: img[title^="Logo di "] count = ${countAfter}`);
        if (countAfter > 0) rendered = true;
    }

    // ── DIAGNOSTIC 4: dump ALL img elements (first 20)
    const allImgs = await page.evaluate(() =>
        [...document.querySelectorAll('img')].slice(0, 20).map(img => ({
            src:   img.getAttribute('src')   || '',
            alt:   img.getAttribute('alt')   || '',
            title: img.getAttribute('title') || '',
        }))
    );
    log.info(`━━━ [${categoria}] ALL IMGS (first 20):`);
    allImgs.forEach((img, i) => log.info(`  [${i}] alt="${img.alt}" title="${img.title}" src="${img.src.slice(0,80)}"`));

    // ── DIAGNOSTIC 5: dump first 3000 chars of body text
    const bodyText = await page.evaluate(() =>
        document.body?.innerText?.slice(0, 3000) ?? ''
    );
    log.info(`━━━ [${categoria}] BODY TEXT (first 3000):\n${bodyText}`);

    // ── DIAGNOSTIC 6: check for React / Next.js / SPA signals
    const spaSignals = await page.evaluate(() => {
        const signals = {};
        signals.hasNextData      = !!document.getElementById('__NEXT_DATA__');
        signals.hasReactRoot     = !!document.getElementById('root') || !!document.getElementById('app') || !!document.getElementById('__nuxt');
        signals.scriptCount      = document.querySelectorAll('script[src]').length;
        signals.hasWindow_data   = typeof window.__data !== 'undefined';
        const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src).filter(s => /chunk|main|app|vendor/i.test(s));
        signals.bundleScripts    = scripts.slice(0, 5);
        return signals;
    });
    log.info(`━━━ [${categoria}] SPA SIGNALS: ${JSON.stringify(spaSignals)}`);

    // ── DIAGNOSTIC 7: look for offer data in script tags (JSON-LD or window.__data__)
    const scriptData = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('script').forEach(s => {
            const content = s.textContent || '';
            if (content.length > 100 && (
                content.includes('offerta') || content.includes('fornitore') ||
                content.includes('prezzo') || content.includes('Edison') ||
                content.includes('Enel') || content.includes('kWh')
            )) {
                results.push({
                    type: s.getAttribute('type') || 'text/javascript',
                    preview: content.slice(0, 400),
                });
            }
        });
        return results.slice(0, 3);
    });

    if (scriptData.length > 0) {
        log.info(`━━━ [${categoria}] OFFER DATA IN SCRIPTS (${scriptData.length} found):`);
        scriptData.forEach((s, i) => log.info(`  [${i}] type="${s.type}" preview: ${s.preview}`));
    } else {
        log.info(`━━━ [${categoria}] No offer data found in script tags`);
    }

    if (!rendered) {
        log.warning(`━━━ [${categoria}] Could not find offer elements — returning 0 offers`);
        return [];
    }

    // ── EXTRACTION (same as before)
    const rawOffers = await page.evaluate(() => {
        const offers = [], seen = new Set();
        document.querySelectorAll('img[title^="Logo di "]').forEach(logoEl => {
            const title     = logoEl.getAttribute('title') || '';
            const fornitore = title.replace(/^Logo di\s+/i, '').trim();
            if (!fornitore || seen.has(fornitore)) return;
            let card = logoEl.parentElement;
            for (let i = 0; i < 8; i++) {
                const t = card?.textContent || '';
                if (t.includes('al mese') || t.includes('Nome offerta')) break;
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

    log.info(`━━━ [${categoria}] RAW OFFERS FOUND: ${rawOffers.length}`);
    if (rawOffers.length > 0) {
        const first = rawOffers[0];
        log.info(`━━━ [${categoria}] FIRST OFFER RAW:`);
        log.info(`  fornitore: "${first.fornitore}"`);
        log.info(`  lines (${first.lines.length}): ${JSON.stringify(first.lines.slice(0, 20))}`);
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

let proxyUrl;
if (proxyConfigInput?.useApifyProxy !== false) {
    const proxyConfiguration = await Actor.createProxyConfiguration(
        proxyConfigInput ?? { useApifyProxy: true }
    );
    proxyUrl = await proxyConfiguration.newUrl();
}

log.info(`PROXY URL: ${proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ':***@') : 'none'}`);

const browser = await chromium.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
    ],
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' },
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
});

// Warmup: visit homepage to get session cookies
log.info('━━━ WARMUP: visiting https://www.segugio.it/');
const warmup = await context.newPage();
try {
    const wRes = await warmup.goto('https://www.segugio.it/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    log.info(`━━━ WARMUP HTTP: ${wRes?.status()} | cookies: ${(await context.cookies()).length}`);
    await warmup.waitForTimeout(2000);
} catch (e) {
    log.warning(`━━━ WARMUP FAILED: ${e.message}`);
} finally {
    await warmup.close();
}

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) continue;
    for (const url of def.urls) {
        const page = await context.newPage();
        try {
            const offers = await scrapePage(page, url, cat, includeSponsored);
            log.info(`━━━ [${cat}] FINAL: ${offers.length} offers to save`);
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
            log.error(`━━━ [${cat}] ERROR: ${e.message}\n${e.stack}`);
        } finally {
            await page.close();
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

await browser.close();
log.info(`━━━ DONE. Total saved: ${savedCount}`);
await Actor.exit();
