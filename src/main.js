/**
 * Segugio.it Scraper v1.4.0
 *
 * Uses PlaywrightCrawler (headless Chrome) because Segugio.it renders
 * offers client-side via JavaScript/React — CheerioCrawler gets empty HTML.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

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

/**
 * Extract offers from a rendered Segugio.it page using Playwright's page object.
 * Waits for offers to be loaded (img[title^="Logo di "] to appear).
 */
async function extractOffersFromPage(page, sourceUrl, categoria, includeSponsored) {
    // Wait for at least one offer logo to appear (confirms JS has rendered)
    try {
        await page.waitForSelector('img[title^="Logo di "]', { timeout: 15000 });
    } catch {
        log.warning(`[${categoria}] Offers did not render within 15s on ${sourceUrl}`);
        return [];
    }

    // Extract data from DOM using page.evaluate
    const rawOffers = await page.evaluate(() => {
        const offers = [];
        const seen   = new Set();

        document.querySelectorAll('img[title^="Logo di "]').forEach(logoEl => {
            const title     = logoEl.getAttribute('title') || '';
            const fornitore = title.replace(/^Logo di\s+/i, '').trim();
            const logoUrl   = logoEl.getAttribute('src') || null;

            if (!fornitore || seen.has(fornitore)) return;

            // Walk up to find containing card
            let card = logoEl.parentElement;
            for (let i = 0; i < 8; i++) {
                const t = card?.textContent || '';
                if (t.includes('al mese') || t.includes('Nome offerta')) break;
                card = card?.parentElement;
            }
            if (!card) return;

            // Extract CTA link
            let urlOfferta = null;
            card.querySelectorAll('a[href]').forEach(a => {
                const href = a.getAttribute('href') || '';
                const txt  = a.textContent.trim();
                if (/scopri|attiva|vai/i.test(txt) && href && href !== '#' && !href.includes('funzionamento')) {
                    urlOfferta = href.startsWith('http') ? href : 'https://tariffe.segugio.it' + href;
                }
            });

            // Get all text lines
            const lines = (card.textContent || '')
                .split(/\n/)
                .map(l => l.trim())
                .filter(Boolean);

            seen.add(fornitore);
            offers.push({ fornitore, logoUrl, urlOfferta, lines });
        });

        return offers;
    });

    // Parse each raw offer
    const offers = [];
    for (const raw of rawOffers) {
        const p = parseCardLines(raw.lines);
        if (!p.prezzoMensileEur && !p.prezzoCommodity) continue;
        if (!includeSponsored && p.sponsorizzata) continue;

        offers.push({
            categoria,
            fornitore:        raw.fornitore,
            nomeOfferta:      p.nomeOfferta,
            prezzoMensile:    p.prezzoMensile,
            prezzoMensileEur: p.prezzoMensileEur,
            prezzoCommodity:  p.prezzoCommodity,
            unitaCommodity:   p.unitaCommodity,
            quotaFissa:       p.quotaFissa,
            quotaFissaEur:    p.quotaFissaEur,
            tipologiaPrezzo:  p.tipologiaPrezzo,
            durataContratto:  p.tipologiaPrezzo?.match(/(\d+)\s*mesi/i)?.[1] ?? null,
            bonus:            p.bonus,
            esclusiva:        p.esclusiva,
            sponsorizzata:    p.sponsorizzata,
            urlOfferta:       raw.urlOfferta,
            logoFornitore:    raw.logoUrl,
            fonte:            sourceUrl,
            scrapedAt:        new Date().toISOString(),
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

let proxyConfiguration;
if (proxyConfigInput?.useApifyProxy !== false) {
    proxyConfiguration = await Actor.createProxyConfiguration(
        proxyConfigInput ?? { useApifyProxy: true }
    );
}

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
    requestHandlerTimeoutSecs: 60,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
    },
    browserPoolOptions: {
        useFingerprints: false,
    },

    async requestHandler({ page, request }) {
        const { categoria } = request.userData;

        // Set Italian locale + headers before navigation
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'it-IT,it;q=0.9',
            'Referer': 'https://www.segugio.it/',
        });

        // Accept cookies if banner appears
        try {
            const cookieBtn = await page.waitForSelector(
                'button:has-text("Accetta"), button:has-text("Accetto"), button:has-text("Accept")',
                { timeout: 5000 }
            );
            if (cookieBtn) await cookieBtn.click();
        } catch { /* no cookie banner */ }

        const offers = await extractOffersFromPage(page, request.url, categoria, includeSponsored);
        log.info(`[${categoria}] ${request.url} → ${offers.length} offers`);

        for (const offer of offers) {
            if (savedCount >= limit) break;
            const key = `${offer.fornitore}||${offer.nomeOfferta}||${categoria}`;
            if (seenGlobal.has(key)) continue;
            seenGlobal.add(key);
            await dataset.pushData(offer);
            savedCount++;
            log.info(`  [${savedCount}] ${offer.fornitore} — ${offer.nomeOfferta} — €${offer.prezzoMensileEur}/mese`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Failed [${request.userData?.categoria}]: ${request.url} — ${error?.message}`);
    },
});

await crawler.run(seedRequests);
log.info(`Done. Total offers saved: ${savedCount}`);
await Actor.exit();
