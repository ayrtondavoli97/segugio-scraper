/**
 * Italian Energy & Telecom Offers Scraper v2.0.0
 *
 * Target: SOStariffe.it (Italy's #2 price comparison portal)
 * Reason: Segugio.it blocks ALL Apify IPs (403 on every proxy option).
 * SOStariffe.it is accessible with standard CheerioCrawler + Apify proxy.
 *
 * Categories:
 *   luce     → sostariffe.it/energia-elettrica/
 *   gas      → sostariffe.it/gas/
 *   luce-gas → sostariffe.it/energia-elettrica-gas/
 *   internet → sostariffe.it/internet-casa/
 *   mobile   → sostariffe.it/tariffe-cellulari/
 *
 * HTML structure (confirmed from live fetch):
 *   Each offer card: [class*="offer"] or [class*="tariffa"] or article
 *   Provider logo: img with data or src containing provider slug
 *   Price: element containing "€" + "/mese" or "/kWh"
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

const BASE = 'https://www.sostariffe.it';

const CATEGORY_URLS = {
    luce:       { label: 'Electricity', urls: [`${BASE}/energia-elettrica/`] },
    gas:        { label: 'Gas',         urls: [`${BASE}/gas/`] },
    'luce-gas': { label: 'Electricity + Gas', urls: [`${BASE}/energia-elettrica-gas/`] },
    internet:   { label: 'Internet/Fiber',    urls: [`${BASE}/internet-casa/`] },
    mobile:     { label: 'Mobile',            urls: [`${BASE}/tariffe-cellulari/`] },
};

function parseEur(raw) {
    if (!raw) return null;
    const n = parseFloat(raw.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
}
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim() || null; }

function extractOffers($, sourceUrl, categoria) {
    const offers = [];
    const seen   = new Set();

    // SOStariffe uses JSON-LD or structured article/div cards
    // Try multiple selector strategies
    const cardSelectors = [
        'article[class*="offer"]',
        'div[class*="offer-card"]',
        'div[class*="tariffa"]',
        'div[class*="result"]',
        '.offer-item',
        '.tariff-card',
        'article',
    ];

    let cards = $();
    for (const sel of cardSelectors) {
        cards = $(sel);
        if (cards.length > 2) {
            log.info(`  Selector "${sel}" → ${cards.length} cards`);
            break;
        }
    }

    if (cards.length === 0) {
        // Fallback: look for JSON-LD structured data
        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const data = JSON.parse($(el).html() || '{}');
                if (data['@type'] === 'ItemList' || Array.isArray(data.itemListElement)) {
                    log.info(`  Found JSON-LD ItemList with ${(data.itemListElement || []).length} items`);
                }
            } catch {}
        });

        // Log first 2000 chars of page text for debugging
        const txt = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 2000);
        log.info(`  Body text preview:\n${txt}`);
        return [];
    }

    cards.each((_, card) => {
        const $c = $(card);

        // Provider: img alt or title, or heading text
        const imgAlt   = $c.find('img').first().attr('alt') || '';
        const imgTitle = $c.find('img').first().attr('title') || '';
        const heading  = $c.find('h2, h3, h4, .provider-name, [class*="provider"], [class*="fornitore"]').first().text();
        const fornitore = clean(imgAlt || imgTitle || heading) || null;

        if (!fornitore || seen.has(fornitore)) return;

        // Offer name
        const nomeOfferta = clean($c.find('[class*="offer-name"], [class*="nome"], [class*="title"], h3, h4').first().text()) || null;

        // Price per month
        const priceText    = $c.text();
        const monthlyMatch = priceText.match(/([\d.,]+)\s*€[^/]*\/\s*mese/i)
            || priceText.match(/([\d.,]+)\s*€[^a-z]*al\s*mese/i);
        const prezzoMensileEur = monthlyMatch ? parseEur(monthlyMatch[1]) : null;
        const prezzoMensile    = monthlyMatch ? monthlyMatch[0].trim() : null;

        // Commodity price
        const kwhMatch  = priceText.match(/([\d.,]+)\s*€\s*\/\s*kWh/i)
            || priceText.match(/(PUN\s*[+\-]\s*[\d.,]+)\s*€\s*\/\s*kWh/i);
        const smcMatch  = priceText.match(/([\d.,]+)\s*€\s*\/\s*Smc/i);
        const prezzoCommodity  = kwhMatch?.[0] || smcMatch?.[0] || null;
        const unitaCommodity   = kwhMatch ? '€/kWh' : smcMatch ? '€/Smc' : null;

        // Fixed fee
        const fixedMatch   = priceText.match(/([\d.,]+)\s*€\s*\/?\s*mese[^s]/i);
        const quotaFissa   = null; // requires deeper parse
        const quotaFissaEur = null;

        // Price type
        const tipoMatch    = priceText.match(/[Ff]isso\s*\d*\s*mesi?|[Vv]ariabile|[Ii]ndicizzato|PUN/);
        const tipologiaPrezzo = tipoMatch ? clean(tipoMatch[0]) : null;

        // Bonus
        const bonusMatch   = priceText.match(/[Ff]ino a .{5,50}€[^€]{0,20}sconto|[Ss]conto .{5,50}€|[Cc]ashback .{5,50}€/);
        const bonus        = bonusMatch ? clean(bonusMatch[0]) : null;

        // URL
        const urlOfferta   = $c.find('a[href]').first().attr('href') || null;
        const fullUrl      = urlOfferta
            ? (urlOfferta.startsWith('http') ? urlOfferta : BASE + urlOfferta)
            : null;

        // Logo
        const logoUrl      = $c.find('img').first().attr('src') || null;

        if (!prezzoMensileEur && !prezzoCommodity) return;
        seen.add(fornitore);

        offers.push({
            categoria, fornitore, nomeOfferta,
            prezzoMensile, prezzoMensileEur,
            prezzoCommodity, unitaCommodity,
            quotaFissa, quotaFissaEur,
            tipologiaPrezzo,
            durataContratto: tipologiaPrezzo?.match(/(\d+)\s*mesi/i)?.[1] ?? null,
            bonus,
            sponsorizzata: /sponsori|pubblicit/i.test($c.attr('class') || ''),
            urlOfferta: fullUrl,
            logoFornitore: logoUrl,
            fonte: sourceUrl,
            scrapedAt: new Date().toISOString(),
        });
    });

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
        seedRequests.push({
            url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'it-IT,it;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            },
            userData: { categoria: cat },
        });
    }
}

log.info(`Scraping SOStariffe.it — ${seedRequests.length} pages: [${categories.join(', ')}]`);

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 45,
    useSessionPool: false,

    async requestHandler({ $, request }) {
        const { categoria } = request.userData;
        const bodyLen = $('body').html()?.length ?? 0;
        log.info(`[${categoria}] ${request.url} | body: ${bodyLen} chars`);

        if (bodyLen < 1000) {
            log.warning(`[${categoria}] Body too small (${bodyLen}) — may be blocked`);
            return;
        }

        const offers = extractOffers($, request.url, categoria);
        log.info(`[${categoria}] → ${offers.length} offers found`);

        for (const offer of offers) {
            if (savedCount >= limit) break;
            if (!includeSponsored && offer.sponsorizzata) continue;
            const key = `${offer.fornitore}||${offer.nomeOfferta}||${categoria}`;
            if (seenGlobal.has(key)) continue;
            seenGlobal.add(key);
            await dataset.pushData(offer);
            savedCount++;
            log.info(`  ✅ [${savedCount}] ${offer.fornitore} — ${offer.nomeOfferta} — €${offer.prezzoMensileEur}/mese`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Failed [${request.userData?.categoria}]: ${request.url} — ${error?.message}`);
    },
});

await crawler.run(seedRequests);
log.info(`Done. Total saved: ${savedCount}`);
await Actor.exit();
