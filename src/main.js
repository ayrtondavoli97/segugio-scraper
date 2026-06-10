/**
 * Italy Energy & Telecom Offers Scraper v2.1.0
 *
 * Target: segugio.it (primary) with SOStariffe.it as fallback structure reference.
 *
 * KEY FIX: blockedStatusCodes: [] in sessionPoolOptions
 * This prevents Crawlee from intercepting the Cloudflare 403 challenge —
 * the browser can then load the page and execute JS normally.
 *
 * + waitForTimeout(5000) after navigation to let Cloudflare challenge complete.
 * + RESIDENTIAL proxy (required for Cloudflare bypass).
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce:       { label: 'Electricity', urls: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`] },
    gas:        { label: 'Gas',         urls: [`${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`] },
    'luce-gas': { label: 'Electricity + Gas', urls: [`${BASE}/migliori-tariffe/migliori-tariffe-luce-gas.aspx`] },
    internet:   { label: 'Internet/Fiber',    urls: [`${BASE}/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx`] },
    mobile:     { label: 'Mobile',            urls: [`${BASE}/tariffe-cellulari/`] },
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

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories       = ['luce', 'gas', 'internet', 'mobile'],
    includeSponsored = true,
    maxItems         = 0,
    proxyConfig: proxyConfigInput,
} = input;

// RESIDENTIAL proxy is required to bypass Cloudflare
const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyConfigInput ?? {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    }
);

const seedRequests = [];
for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) continue;
    for (const url of def.urls) {
        seedRequests.push({ url, userData: { categoria: cat } });
    }
}

log.info(`Scraping ${seedRequests.length} pages: [${categories.join(', ')}]`);

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 2,
    requestHandlerTimeoutSecs: 90,

    // KEY: empty blockedStatusCodes so Crawlee doesn't throw on Cloudflare 403
    // The browser will handle the challenge and load the page normally
    sessionPoolOptions: {
        blockedStatusCodes: [],
    },

    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
    },

    async requestHandler({ page, request }) {
        const { categoria } = request.userData;

        // Wait for Cloudflare challenge to complete (if any)
        await page.waitForTimeout(5000);

        const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);
        const title   = await page.title();
        log.info(`[${categoria}] "${title}" | body: ${bodyLen} chars`);

        if (bodyLen < 1000) {
            log.warning(`[${categoria}] Body too small — still blocked`);
            return;
        }

        // Wait for React to render offer cards
        try {
            await page.waitForSelector('img[title^="Logo di "]', { timeout: 20000 });
            log.info(`[${categoria}] ✅ Offers rendered`);
        } catch {
            await page.evaluate(() => window.scrollTo(0, 600));
            await page.waitForTimeout(3000);
        }

        const count = await page.locator('img[title^="Logo di "]').count();
        log.info(`[${categoria}] img[title^="Logo di "] count: ${count}`);

        if (count === 0) {
            const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
            log.warning(`[${categoria}] No offers. Body:\n${txt}`);
            return;
        }

        // Extract from DOM
        const rawOffers = await page.evaluate(() => {
            const offers = [], seen = new Set();
            document.querySelectorAll('img[title^="Logo di "]').forEach(logoEl => {
                const fornitore = (logoEl.getAttribute('title') || '').replace(/^Logo di\s+/i, '').trim();
                if (!fornitore || seen.has(fornitore)) return;
                let card = logoEl.parentElement;
                for (let i = 0; i < 8; i++) {
                    if ((card?.textContent || '').includes('al mese') ||
                        (card?.textContent || '').includes('Nome offerta')) break;
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

        log.info(`[${categoria}] ${rawOffers.length} raw offers`);
        if (rawOffers[0]) {
            log.info(`  first: "${rawOffers[0].fornitore}" | lines: ${JSON.stringify(rawOffers[0].lines.slice(0, 10))}`);
        }

        for (const raw of rawOffers) {
            if (savedCount >= limit) break;
            const p = parseCardLines(raw.lines);
            if (!p.prezzoMensileEur && !p.prezzoCommodity) continue;
            if (!includeSponsored && p.sponsorizzata) continue;
            const key = `${raw.fornitore}||${p.nomeOfferta}||${categoria}`;
            if (seenGlobal.has(key)) continue;
            seenGlobal.add(key);

            await dataset.pushData({
                categoria, fornitore: raw.fornitore,
                nomeOfferta: p.nomeOfferta, prezzoMensile: p.prezzoMensile,
                prezzoMensileEur: p.prezzoMensileEur, prezzoCommodity: p.prezzoCommodity,
                unitaCommodity: p.unitaCommodity, quotaFissa: p.quotaFissa,
                quotaFissaEur: p.quotaFissaEur, tipologiaPrezzo: p.tipologiaPrezzo,
                durataContratto: p.tipologiaPrezzo?.match(/(\d+)\s*mesi/i)?.[1] ?? null,
                bonus: p.bonus, esclusiva: p.esclusiva, sponsorizzata: p.sponsorizzata,
                urlOfferta: raw.urlOfferta, logoFornitore: raw.logoUrl,
                fonte: request.url, scrapedAt: new Date().toISOString(),
            });
            savedCount++;
            log.info(`  ✅ [${savedCount}] ${raw.fornitore} — ${p.nomeOfferta} — €${p.prezzoMensileEur}/mese`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Failed [${request.userData?.categoria}]: ${request.url} — ${error?.message}`);
    },
});

await crawler.run(seedRequests);
log.info(`Done. Total saved: ${savedCount}`);
await Actor.exit();
