/**
 * Segugio.it Scraper v1.0.0
 *
 * Scrapes all publicly available offers from Segugio.it:
 *   - Electricity (luce)     tariffe.segugio.it/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx
 *   - Gas                    tariffe.segugio.it/costo-gas-metano/lista-offerte-gas-metano.aspx
 *   - Dual fuel (luce+gas)   tariffe.segugio.it/migliori-tariffe/migliori-tariffe-luce-gas.aspx
 *   - Internet/fiber         tariffe.segugio.it/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx
 *   - Mobile                 tariffe.segugio.it/tariffe-cellulari/
 *
 * HTML structure (confirmed from live pages):
 *   Each offer card contains:
 *     - Provider logo img[alt^="logo "] → fornitore
 *     - "Nome offerta" label + value
 *     - "Prezzo Luce/Gas" label + value (e.g. "0,122 €/kWh")
 *     - "Quota fissa" label + value (e.g. "7,50 €/mese")
 *     - "Prezzo" label + value (e.g. "Fisso 12 mesi" / "Variabile")
 *     - Monthly cost in large text (e.g. "31,87 €")
 *     - Bonus text (sparkles icon + text)
 *     - "Annuncio sponsorizzato" flag
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// ─── URL map ──────────────────────────────────────────────────────────────────

const CATEGORY_URLS = {
    luce: {
        label: 'Electricity',
        urls: [
            'https://tariffe.segugio.it/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx',
            'https://tariffe.segugio.it/costo-energia-elettrica/lista-offerte-luce-prezzo-fisso.aspx',
            'https://tariffe.segugio.it/costo-energia-elettrica/lista-offerte-luce-prezzo-variabile.aspx',
        ],
    },
    gas: {
        label: 'Gas',
        urls: [
            'https://tariffe.segugio.it/costo-gas-metano/lista-offerte-gas-metano.aspx',
            'https://tariffe.segugio.it/costo-gas-metano/lista-offerte-gas-prezzo-fisso.aspx',
            'https://tariffe.segugio.it/costo-gas-metano/lista-offerte-gas-prezzo-variabile.aspx',
        ],
    },
    'luce-gas': {
        label: 'Electricity + Gas',
        urls: [
            'https://tariffe.segugio.it/migliori-tariffe/migliori-tariffe-luce-gas.aspx',
            'https://tariffe.segugio.it/migliori-tariffe/migliori-tariffe-luce.aspx',
            'https://tariffe.segugio.it/migliori-tariffe/migliori-tariffe-gas.aspx',
        ],
    },
    internet: {
        label: 'Internet / Fiber',
        urls: [
            'https://tariffe.segugio.it/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx',
            'https://tariffe.segugio.it/tariffe-adsl-internet/offerte-fibra-ottica.aspx',
            'https://tariffe.segugio.it/tariffe-adsl-internet/offerte-fibra-1000-mega.aspx',
        ],
    },
    mobile: {
        label: 'Mobile',
        urls: [
            'https://tariffe.segugio.it/tariffe-cellulari/',
        ],
    },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Parse "31,87 €" or "31.87" → number */
function parseEur(raw) {
    if (!raw) return null;
    const n = parseFloat(raw.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
}

/** Clean text: collapse whitespace, strip leading/trailing */
function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim() || null;
}

/**
 * Extract offers from a Segugio.it listing page.
 *
 * HTML structure (confirmed from live fetches):
 *
 * Each offer block contains multiple sub-sections:
 *   - img[alt^="logo "] → provider name + logo URL
 *   - Large price "XX,XX €\nal mese" → monthly cost
 *   - Definition rows: "Nome offerta", "Prezzo Luce/Gas", "Quota fissa", "Prezzo"
 *   - Bonus: sparkles icon sibling text
 *   - Sponsored: "Annuncio sponsorizzato" text
 *   - CTA link "Scopri l'offerta" → offer URL
 *
 * Segugio renders each offer TWICE (desktop + mobile card) so we dedup by (fornitore+nomeOfferta).
 */
function extractOffers($, sourceUrl, categoria, includeSponsored) {
    const offers = [];
    const seen = new Set();

    // Find all provider logos — each marks the start of an offer card
    $('img[alt^="logo "]').each((_, logoEl) => {
        const $logo = $(logoEl);

        // Get the container: walk up to find a block that contains the full card
        // Segugio wraps each card in a div with class containing "card" or similar
        // We use the logo's closest ancestor that has price info
        let $card = $logo.closest('div, article, section').first();

        // If the card is too small, walk up
        for (let i = 0; i < 6; i++) {
            if ($card.text().includes('al mese') || $card.text().includes('€/kWh') || $card.text().includes('€/Smc') || $card.text().includes('€/mese')) break;
            $card = $card.parent();
        }

        // Provider name from alt attribute
        const altText = $logo.attr('alt') || '';
        const fornitore = clean(altText.replace(/^logo\s+/i, '')) || null;
        const logoUrl   = $logo.attr('src') || null;

        // Skip duplicate cards (Segugio renders desktop + mobile versions)
        const cardText  = $card.text().replace(/\s+/g, ' ').trim();

        // Extract monthly price — look for the large "XX,XX € al mese" pattern
        const monthlyMatch = cardText.match(/([\d.,]+)\s*€\s*al\s*mese/i);
        const prezzoMensile    = monthlyMatch ? monthlyMatch[0].replace(/\s+/g, ' ').trim() : null;
        const prezzoMensileEur = monthlyMatch ? parseEur(monthlyMatch[1]) : null;

        // Extract labeled fields from the card text
        // Pattern: "Nome offerta\nVALUE" or "Nome offerta VALUE"
        const getLabelValue = (label) => {
            const re = new RegExp(label + '[:\\s]+([^\\n\\r]+)', 'i');
            const m  = cardText.match(re);
            return m ? clean(m[1].split('\n')[0].split('Quota')[0].split('Prezzo')[0]) : null;
        };

        const nomeOfferta    = getLabelValue('Nome offerta');
        const prezzoRaw      = getLabelValue('Prezzo Luce') || getLabelValue('Prezzo Gas') || getLabelValue('Prezzo energia') || null;
        const quotaFissaRaw  = getLabelValue('Quota fissa');
        const tipologiaRaw   = getLabelValue('Prezzo');

        // Parse commodity price and unit (e.g. "0,122 €/kWh" → 0.122, "€/kWh")
        let prezzoCommodity = null;
        let unitaCommodity  = null;
        if (prezzoRaw) {
            const cpMatch = prezzoRaw.match(/([\d.,]+)\s*(€\/\w+)/i)
                || prezzoRaw.match(/(PUN|PSV)\s*[+\-]\s*[\d.,]+\s*(€\/\w+)/i);
            if (cpMatch) {
                prezzoCommodity = clean(prezzoRaw);
                unitaCommodity  = cpMatch[2] || null;
            } else {
                prezzoCommodity = clean(prezzoRaw);
            }
        }

        // Internet/mobile: extract price differently (no kWh)
        const eurmese = cardText.match(/([\d.,]+)\s*€\s*\/\s*mese/i);
        if (!prezzoMensileEur && eurmese) {
            // Handled below
        }

        const quotaFissaEur = quotaFissaRaw ? parseEur(quotaFissaRaw) : null;

        // Bonus text (after sparkles icon — look for patterns like "Fino a X€ di sconto")
        const bonusMatch = cardText.match(/Fino a [^.!\n]+|Sconto [^.!\n]+|Cashback [^.!\n]+|Offerta esclusiva[^.!\n]*/i);
        const bonus = bonusMatch ? clean(bonusMatch[0]) : null;

        // Sponsored flag
        const sponsorizzata = /Annuncio sponsorizzato/i.test(cardText);
        if (!includeSponsored && sponsorizzata) return;

        // Offer URL — "Scopri l'offerta" link
        let urlOfferta = null;
        $card.find('a').each((_, a) => {
            const href = $(a).attr('href') || '';
            const text = $(a).text().trim();
            if (/scopri|offerta|dettaglio|attiva/i.test(text) && href && href !== '#') {
                urlOfferta = href.startsWith('http') ? href : 'https://tariffe.segugio.it' + href;
            }
        });

        // Dedup key
        const key = `${fornitore}||${nomeOfferta}||${categoria}`;
        if (seen.has(key) || !fornitore) return;
        seen.add(key);

        // Skip cards with no meaningful data
        if (!nomeOfferta && !prezzoMensile && !prezzoCommodity) return;

        offers.push({
            categoria,
            fornitore,
            nomeOfferta,
            prezzoMensile,
            prezzoMensileEur,
            prezzoCommodity,
            unitaCommodity,
            quotaFissa: quotaFissaRaw || null,
            quotaFissaEur,
            tipologiaPrezzo: tipologiaRaw || null,
            durataContratto: null,   // parsed from tipologiaPrezzo downstream if needed
            bonus,
            sponsorizzata,
            urlOfferta,
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
    proxyConfiguration = await Actor.createProxyConfiguration(proxyConfigInput ?? { useApifyProxy: true });
}

// Build seed requests
const seedRequests = [];
for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) { log.warning(`Unknown category: ${cat}`); continue; }
    for (const url of def.urls) {
        seedRequests.push({ url, userData: { categoria: cat, label: def.label } });
    }
}

log.info(`Scraping ${seedRequests.length} pages across ${categories.length} categories`);

const dataset = await Dataset.open();
const seenGlobal = new Set();
let savedCount = 0;
const limit = maxItems > 0 ? maxItems * categories.length : Infinity;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 5,
    maxRequestsPerMinute: 60,
    requestHandlerTimeoutSecs: 30,

    async requestHandler({ $, request }) {
        const { categoria } = request.userData;
        const sourceUrl = request.url;

        const offers = extractOffers($, sourceUrl, categoria, includeSponsored);
        log.info(`[${categoria}] ${sourceUrl} → ${offers.length} offers found`);

        for (const offer of offers) {
            if (savedCount >= limit) break;
            const key = `${offer.fornitore}||${offer.nomeOfferta}||${offer.categoria}`;
            if (seenGlobal.has(key)) continue;
            seenGlobal.add(key);
            await dataset.pushData(offer);
            savedCount++;
        }
    },

    failedRequestHandler({ request }) {
        log.warning(`Failed: ${request.url}`);
    },
});

await crawler.run(seedRequests);

log.info(`Done. Total offers saved: ${savedCount}`);
await Actor.exit();
