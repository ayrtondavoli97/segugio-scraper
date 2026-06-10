/**
 * Segugio.it Scraper v1.1.0
 *
 * Scrapes offers from Segugio.it:
 *   - Electricity (luce)
 *   - Gas
 *   - Dual fuel (luce+gas)
 *   - Internet/fiber
 *   - Mobile
 *
 * HTML structure confirmed from live pages.
 * Each card is separated by <hr> and rendered TWICE (desktop+mobile).
 * We use the FIRST instance only (more complete data).
 *
 * Card structure (within each block between <hr> tags):
 *   img[title^="Logo di "]  → fornitore name + logo URL
 *   "XX,XX €\nal mese"     → prezzoMensile
 *   Lines: "Nome offerta\nVALUE", "Prezzo Luce\nVALUE", "Quota fissa\nVALUE", "Prezzo\nVALUE"
 *   img[src*="sparkles"] sibling text → bonus
 *   "*Annuncio sponsorizzato" → sponsorizzata
 *   a[href] containing "scopri" or known CTA patterns → urlOfferta
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';

// Only use main listing pages — sub-pages (prezzo-fisso etc.) get 403
const CATEGORY_URLS = {
    luce: {
        label: 'Electricity',
        commodity: 'luce',
        urls: [
            `${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`,
        ],
    },
    gas: {
        label: 'Gas',
        commodity: 'gas',
        urls: [
            `${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`,
        ],
    },
    'luce-gas': {
        label: 'Electricity + Gas',
        commodity: 'dual',
        urls: [
            `${BASE}/migliori-tariffe/migliori-tariffe-luce-gas.aspx`,
        ],
    },
    internet: {
        label: 'Internet / Fiber',
        commodity: 'internet',
        urls: [
            `${BASE}/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx`,
        ],
    },
    mobile: {
        label: 'Mobile',
        commodity: 'mobile',
        urls: [
            `${BASE}/tariffe-cellulari/`,
        ],
    },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseEur(raw) {
    if (!raw) return null;
    const n = parseFloat(raw.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim() || null;
}

/**
 * Parse a block of text (one offer card) into structured fields.
 *
 * The card text has this line structure (newline-separated):
 *   ...
 *   Nome offerta
 *   Web Luce
 *   Prezzo Luce        (or "Prezzo Gas" for gas cards)
 *   0,122 €/kWh
 *   Quota fissa
 *   7,50 €/mese
 *   Prezzo
 *   Fisso 12 mesi
 *   ...
 *   sparkles (icon text or preceding text)
 *   Bonus description
 *   ...
 */
function parseCardText(lines) {
    const KNOWN_LABELS = new Set([
        'Nome offerta', 'Prezzo Luce', 'Prezzo Gas', 'Prezzo energia',
        'Quota fissa', 'Prezzo', 'Velocità', 'Tecnologia', 'GB inclusi',
        'Minuti', 'SMS',
    ]);

    const result = {
        nomeOfferta: null,
        prezzoCommodity: null,
        unitaCommodity: null,
        quotaFissa: null,
        quotaFissaEur: null,
        tipologiaPrezzo: null,
        prezzoMensile: null,
        prezzoMensileEur: null,
        bonus: null,
        sponsorizzata: false,
        esclusiva: false,
    };

    // Monthly price: "XX,XX €" followed by "al mese" on next line or same
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];

        // Monthly price
        if (/^\d[\d.,]* €$/.test(l) && i + 1 < lines.length && lines[i+1] === 'al mese') {
            result.prezzoMensile = `${l} al mese`;
            result.prezzoMensileEur = parseEur(l);
        }

        // Sponsored
        if (/Annuncio sponsorizzato/i.test(l)) result.sponsorizzata = true;
        if (/Offerta esclusiva/i.test(l)) result.esclusiva = true;

        // Label/value pairs
        if (KNOWN_LABELS.has(l) && i + 1 < lines.length) {
            const val = lines[i + 1];
            if (val && !KNOWN_LABELS.has(val) && val !== 'al mese' && val !== 'Altri dettagli') {
                switch (l) {
                    case 'Nome offerta':
                        result.nomeOfferta = clean(val);
                        break;
                    case 'Prezzo Luce':
                    case 'Prezzo Gas':
                    case 'Prezzo energia': {
                        result.prezzoCommodity = clean(val);
                        const unitMatch = val.match(/€\/(\w+)/);
                        result.unitaCommodity = unitMatch ? `€/${unitMatch[1]}` : null;
                        break;
                    }
                    case 'Quota fissa':
                        result.quotaFissa = clean(val);
                        result.quotaFissaEur = parseEur(val);
                        break;
                    case 'Prezzo':
                        // Only take clean price type values, not commodity prices
                        if (!/€\//.test(val) && !/\d,\d/.test(val)) {
                            result.tipologiaPrezzo = clean(val);
                        }
                        break;
                }
            }
        }
    }

    // Bonus: text after "sparkles" icon line or matching bonus patterns
    const bonusPatterns = [
        /^(Fino a .+)/i,
        /^(Sconto .+)/i,
        /^(Cashback .+)/i,
        /^(\d+€.+sconto.+)/i,
        /^(La nuova .+)/i,
        /^(\d+€\/mese .+)/i,
    ];
    for (const line of lines) {
        for (const pat of bonusPatterns) {
            const m = line.match(pat);
            if (m) { result.bonus = clean(m[1]); break; }
        }
        if (result.bonus) break;
    }

    return result;
}

/**
 * Extract all offers from a Segugio.it listing page using Cheerio.
 *
 * Key insight: each offer is between two <hr> elements.
 * The first img with title="Logo di NOME" gives the provider.
 * We skip the second (mobile) copy by deduplicating on fornitore+nome.
 */
function extractOffers($, sourceUrl, categoria, includeSponsored) {
    const offers = [];
    const seen = new Set();

    // Strategy: find all images whose title starts with "Logo di "
    // These mark the start of each offer card
    $('img[title^="Logo di "]').each((_, logoEl) => {
        const $logo = $(logoEl);
        const title = $logo.attr('title') || '';
        const fornitore = clean(title.replace(/^Logo di\s+/i, ''));
        const logoUrl   = $logo.attr('src') || null;

        if (!fornitore) return;

        // Walk up to find the containing card block
        // Segugio wraps each in a div; we go up until we find something
        // that contains "al mese" (indicates it's a complete card)
        let $card = $logo.parent();
        for (let i = 0; i < 8; i++) {
            if ($card.text().includes('al mese') || $card.text().includes('Nome offerta')) break;
            $card = $card.parent();
        }

        const rawText = $card.text();

        // Dedup: skip if we've already seen this fornitore on this page
        // (avoids desktop+mobile duplicate)
        if (seen.has(fornitore)) return;

        // Parse the card text line by line
        const lines = rawText
            .split(/\n/)
            .map(l => l.trim())
            .filter(l => l && l !== '\n');

        const parsed = parseCardText(lines);

        // Skip if no meaningful price data
        if (!parsed.prezzoMensileEur && !parsed.prezzoCommodity) return;

        // Sponsored filter
        if (!includeSponsored && parsed.sponsorizzata) return;

        seen.add(fornitore);

        // Extract offer URL: find nearby CTA link
        let urlOfferta = null;
        $card.find('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            const txt  = $(a).text().trim();
            if (/scopri|attiva|vai all/i.test(txt) && href && href !== '#' && href !== '') {
                const full = href.startsWith('http') ? href : BASE + href;
                if (!full.includes('funzionamento')) urlOfferta = full;
            }
        });

        offers.push({
            categoria,
            fornitore,
            nomeOfferta:      parsed.nomeOfferta,
            prezzoMensile:    parsed.prezzoMensile,
            prezzoMensileEur: parsed.prezzoMensileEur,
            prezzoCommodity:  parsed.prezzoCommodity,
            unitaCommodity:   parsed.unitaCommodity,
            quotaFissa:       parsed.quotaFissa,
            quotaFissaEur:    parsed.quotaFissaEur,
            tipologiaPrezzo:  parsed.tipologiaPrezzo,
            durataContratto:  parsed.tipologiaPrezzo
                ? (parsed.tipologiaPrezzo.match(/(\d+)\s*mesi/i)?.[1] ?? null)
                : null,
            bonus:            parsed.bonus,
            esclusiva:        parsed.esclusiva,
            sponsorizzata:    parsed.sponsorizzata,
            urlOfferta,
            logoFornitore:    logoUrl,
            fonte:            sourceUrl,
            scrapedAt:        new Date().toISOString(),
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
    proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput ?? {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });
}

const seedRequests = [];
for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) { log.warning(`Unknown category: ${cat}`); continue; }
    for (const url of def.urls) {
        seedRequests.push({
            url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9',
                'Referer': 'https://www.segugio.it/',
            },
            userData: { categoria: cat },
        });
    }
}

log.info(`Scraping ${seedRequests.length} pages for categories: [${categories.join(', ')}]`);

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 3,
    maxRequestsPerMinute: 30,
    requestHandlerTimeoutSecs: 45,
    ignoreSslErrors: true,

    async requestHandler({ $, request }) {
        const { categoria } = request.userData;
        const offers = extractOffers($, request.url, categoria, includeSponsored);
        log.info(`[${categoria}] ${request.url} → ${offers.length} offers`);

        for (const offer of offers) {
            if (savedCount >= limit) break;
            const key = `${offer.fornitore}||${offer.nomeOfferta}||${categoria}`;
            if (seenGlobal.has(key)) continue;
            seenGlobal.add(key);
            await dataset.pushData(offer);
            savedCount++;
            log.debug(`Saved [${savedCount}]: ${offer.fornitore} — ${offer.nomeOfferta} — €${offer.prezzoMensileEur}/mese`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.warning(`Failed [${request.userData.categoria}]: ${request.url} — ${error.message}`);
    },
});

await crawler.run(seedRequests);
log.info(`Done. Total offers saved: ${savedCount}`);
await Actor.exit();
