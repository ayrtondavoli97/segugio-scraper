/**
 * Segugio.it Scraper v1.3.0
 *
 * Uses CheerioCrawler with session pool disabled and custom headers
 * to bypass Segugio.it's WAF bot detection.
 */

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce:       { label: 'Electricity',      urls: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`] },
    gas:        { label: 'Gas',              urls: [`${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`] },
    'luce-gas': { label: 'Electricity + Gas',urls: [`${BASE}/migliori-tariffe/migliori-tariffe-luce-gas.aspx`] },
    internet:   { label: 'Internet/Fiber',   urls: [`${BASE}/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx`] },
    mobile:     { label: 'Mobile',           urls: [`${BASE}/tariffe-cellulari/`] },
};

const CUSTOM_HEADERS = {
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding':           'gzip, deflate, br',
    'Referer':                   'https://www.segugio.it/',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'same-site',
    'Sec-Fetch-User':            '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control':             'max-age=0',
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseEur(raw) {
    if (!raw) return null;
    const n = parseFloat(raw.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : Math.round(n * 100) / 100;
}
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim() || null; }

const KNOWN_LABELS = new Set([
    'Nome offerta','Prezzo Luce','Prezzo Gas','Prezzo energia',
    'Quota fissa','Prezzo','Velocità','Tecnologia','GB inclusi','Minuti','SMS',
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
        if (/^\d[\d.,]* €$/.test(l) && lines[i+1] === 'al mese') {
            r.prezzoMensile    = `${l} al mese`;
            r.prezzoMensileEur = parseEur(l);
        }
        if (/Annuncio sponsorizzato/i.test(l)) r.sponsorizzata = true;
        if (/Offerta esclusiva/i.test(l))      r.esclusiva     = true;
        if (KNOWN_LABELS.has(l) && i+1 < lines.length) {
            const val = lines[i+1];
            if (val && !KNOWN_LABELS.has(val) && val !== 'al mese' && val !== 'Altri dettagli') {
                if (l === 'Nome offerta')  r.nomeOfferta = clean(val);
                if (['Prezzo Luce','Prezzo Gas','Prezzo energia'].includes(l)) {
                    r.prezzoCommodity = clean(val);
                    const um = val.match(/€\/(\w+)/);
                    r.unitaCommodity  = um ? `€/${um[1]}` : null;
                }
                if (l === 'Quota fissa') { r.quotaFissa = clean(val); r.quotaFissaEur = parseEur(val); }
                if (l === 'Prezzo' && !/€\//.test(val) && !/^\d,\d/.test(val)) r.tipologiaPrezzo = clean(val);
            }
        }
    }
    const bonusRx = [/^(Fino a .+)/i,/^(Sconto .+)/i,/^(Cashback .+)/i,/^(\d+€.+sconto.+)/i,/^(La nuova .+)/i,/^(\d+€\/mese .+)/i];
    for (const line of lines) {
        for (const rx of bonusRx) { const m = line.match(rx); if (m) { r.bonus = clean(m[1]); break; } }
        if (r.bonus) break;
    }
    return r;
}

function extractOffers($, sourceUrl, categoria, includeSponsored) {
    const offers = [], seen = new Set();
    $('img[title^="Logo di "]').each((_, el) => {
        const $l = $(el);
        const fornitore = clean(($l.attr('title')||'').replace(/^Logo di\s+/i,''));
        if (!fornitore || seen.has(fornitore)) return;
        let $card = $l.parent();
        for (let i=0; i<8; i++) {
            if ($card.text().includes('al mese')||$card.text().includes('Nome offerta')) break;
            $card = $card.parent();
        }
        const lines = $card.text().split(/\n/).map(l=>l.trim()).filter(Boolean);
        const p = parseCardLines(lines);
        if (!p.prezzoMensileEur && !p.prezzoCommodity) return;
        if (!includeSponsored && p.sponsorizzata) return;
        seen.add(fornitore);
        let urlOfferta = null;
        $card.find('a[href]').each((_,a) => {
            const href=$(a).attr('href')||'', txt=$(a).text().trim();
            if (/scopri|attiva|vai/i.test(txt)&&href&&href!=='#'&&!href.includes('funzionamento'))
                urlOfferta = href.startsWith('http')?href:BASE+href;
        });
        offers.push({
            categoria, fornitore,
            nomeOfferta: p.nomeOfferta, prezzoMensile: p.prezzoMensile,
            prezzoMensileEur: p.prezzoMensileEur, prezzoCommodity: p.prezzoCommodity,
            unitaCommodity: p.unitaCommodity, quotaFissa: p.quotaFissa,
            quotaFissaEur: p.quotaFissaEur, tipologiaPrezzo: p.tipologiaPrezzo,
            durataContratto: p.tipologiaPrezzo?.match(/(\d+)\s*mesi/i)?.[1] ?? null,
            bonus: p.bonus, esclusiva: p.esclusiva, sponsorizzata: p.sponsorizzata,
            urlOfferta, logoFornitore: $l.attr('src')||null,
            fonte: sourceUrl, scrapedAt: new Date().toISOString(),
        });
    });
    return offers;
}

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const {
    categories = ['luce','gas','internet','mobile'],
    includeSponsored = true,
    maxItems = 0,
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
        seedRequests.push({ url, headers: CUSTOM_HEADERS, userData: { categoria: cat } });
    }
}

log.info(`Scraping ${seedRequests.length} pages: [${categories.join(', ')}]`);

const dataset = await Dataset.open();
const seenGlobal = new Set();
let savedCount = 0;
const limit = maxItems > 0 ? maxItems * categories.length : Infinity;

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 2,
    maxRequestsPerMinute: 15,
    requestHandlerTimeoutSecs: 45,
    useSessionPool: false,
    persistCookiesPerSession: false,

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
