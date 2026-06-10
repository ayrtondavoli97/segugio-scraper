/**
 * Segugio.it Scraper v1.5.0
 *
 * Uses Playwright directly (no Crawlee crawler wrapper) to bypass
 * Crawlee's _throwOnBlockedRequest which intercepts 403 before the
 * browser can even load the page.
 *
 * Segugio.it returns 403 on the initial HTTP request but the browser
 * (with proper headers/cookies) loads fine via JS navigation.
 */

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce:       { label: 'Electricity',       urls: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`] },
    gas:        { label: 'Gas',               urls: [`${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`] },
    'luce-gas': { label: 'Electricity + Gas', urls: [`${BASE}/migliori-tariffe/migliori-tariffe-luce-gas.aspx`] },
    internet:   { label: 'Internet/Fiber',    urls: [`${BASE}/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx`] },
    mobile:     { label: 'Mobile',            urls: [`${BASE}/tariffe-cellulari/`] },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    log.info(`[${categoria}] Navigating: ${url}`);

    // Navigate ignoring HTTP errors — Playwright continues even on 403
    const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });

    const status = response?.status();
    log.info(`[${categoria}] HTTP ${status}`);

    // Wait for React to render offer cards
    try {
        await page.waitForSelector('img[title^="Logo di "]', { timeout: 20000 });
        log.info(`[${categoria}] Offers rendered`);
    } catch {
        // Try scrolling to trigger lazy loading
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(3000);
        const count = await page.locator('img[title^="Logo di "]').count();
        if (count === 0) {
            log.warning(`[${categoria}] No offers found after scroll on ${url}`);
            return [];
        }
    }

    // Extract from DOM
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
    categories       = ['luce', 'gas', 'internet', 'mobile'],
    includeSponsored = true,
    maxItems         = 0,
    proxyConfig: proxyConfigInput,
} = input;

// Build proxy URL if needed
let proxyUrl = undefined;
if (proxyConfigInput?.useApifyProxy !== false) {
    const proxyConfiguration = await Actor.createProxyConfiguration(
        proxyConfigInput ?? { useApifyProxy: true }
    );
    proxyUrl = await proxyConfiguration.newUrl();
}

// Launch browser directly via Playwright
const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9' },
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
});

// Visit homepage first to get cookies/session
const warmupPage = await context.newPage();
await warmupPage.goto('https://www.segugio.it/', { waitUntil: 'domcontentloaded', timeout: 20000 });
log.info('Warmup page loaded — cookies acquired');
await warmupPage.waitForTimeout(1500);
await warmupPage.close();

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) { log.warning(`Unknown category: ${cat}`); continue; }

    for (const url of def.urls) {
        const page = await context.newPage();
        try {
            const offers = await scrapePage(page, url, cat, includeSponsored);
            log.info(`[${cat}] → ${offers.length} offers found`);

            for (const offer of offers) {
                if (savedCount >= limit) break;
                const key = `${offer.fornitore}||${offer.nomeOfferta}||${cat}`;
                if (seenGlobal.has(key)) continue;
                seenGlobal.add(key);
                await dataset.pushData(offer);
                savedCount++;
                log.info(`  [${savedCount}] ${offer.fornitore} — ${offer.nomeOfferta} — €${offer.prezzoMensileEur}/mese`);
            }
        } catch (e) {
            log.error(`[${cat}] ${url}: ${e.message}`);
        } finally {
            await page.close();
        }

        await new Promise(r => setTimeout(r, 2000));
    }
}

await browser.close();
log.info(`Done. Total offers saved: ${savedCount}`);
await Actor.exit();
