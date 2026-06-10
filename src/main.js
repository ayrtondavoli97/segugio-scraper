/**
 * Italy Luce & Gas Offers Scraper v2.1.0
 *
 * Source: ARERA Portale Offerte open data
 *   ilportaleofferte.it/portaleOfferte/it/open-data.page
 *
 * URL patterns confirmed from real samples:
 *   PLACET CSV:  /resources/opendata/csv/offerte/{YYYY}_{M}/PO_Offerte_{E|G}_PLACET_{YYYYMMDD}.csv
 *   MLIBERO XML: /resources/opendata/csv/offerteML/{YYYY}_{M}/PO_Offerte_{E|G}_MLIBERO_{YYYYMMDD}.xml
 *
 *   YYYY = year, M = month (1-12, NOT zero-padded)
 *
 * Real samples observed:
 *   2025_2/PO_Offerte_E_PLACET_20250213.csv
 *   2025_3/PO_Offerte_E_MLIBERO_20250312.xml
 *   2024_3/PO_Offerte_D_MLIBERO_20240310.xml
 *   2023_1/PO_Offerte_E_PLACET_20230125.csv
 *
 * Files published: monthly, around day 6-13. Page says "Ultimo aggiornamento: 06-05-2026"
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'crawlee';

const BASE = 'https://www.ilportaleofferte.it/portaleOfferte/resources/opendata/csv';

// ─── helpers ──────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function dateToYmd(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Build URL for a given date and commodity.
 * commodity: 'E' (electricity) | 'G' (gas)
 * dataset: 'PLACET' | 'MLIBERO'
 */
function buildUrl(date, commodity, dataset = 'PLACET') {
    const year  = date.getFullYear();
    const month = date.getMonth() + 1; // 1-12, NOT zero-padded
    const ymd   = dateToYmd(date);
    const ext   = dataset === 'MLIBERO' ? 'xml' : 'csv';
    const dir   = dataset === 'MLIBERO' ? 'offerteML' : 'offerte';
    return `${BASE}/${dir}/${year}_${month}/PO_Offerte_${commodity}_${dataset}_${ymd}.${ext}`;
}

/** HEAD request to check if a URL exists (faster than GET) */
async function urlExists(url, headers) {
    try {
        const res = await gotScraping({
            url,
            method: 'HEAD',
            headers,
            timeout: { request: 8000 },
            throwHttpErrors: false,
            followRedirect: false,
        });
        return res.statusCode === 200;
    } catch {
        return false;
    }
}

async function downloadText(url, headers) {
    const res = await gotScraping({
        url, headers,
        timeout: { request: 60000 },
        throwHttpErrors: false,
        decompress: true,
    });
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
    return res.body;
}

/**
 * Find latest available CSV/XML for a given commodity and dataset.
 * Tries every day in the last 90 days; logs first few attempts for visibility.
 */
async function findLatestFile(commodity, dataset, headers) {
    const today = new Date();
    log.info(`Searching for latest ${commodity}/${dataset} file (90 days back)...`);

    const triedUrls = [];

    for (let daysBack = 0; daysBack < 90; daysBack++) {
        const d = new Date(today);
        d.setDate(d.getDate() - daysBack);
        const url = buildUrl(d, commodity, dataset);

        if (triedUrls.length < 5) triedUrls.push(url);

        const exists = await urlExists(url, headers);
        if (exists) {
            log.info(`✅ Found: ${url} (${daysBack} days back)`);
            return url;
        }
    }

    log.warning(`No file found in 90 days. First 5 URLs tried:`);
    triedUrls.forEach(u => log.warning(`  - ${u}`));
    return null;
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function splitCsvLine(line, delim = ',') {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === delim && !inQ) { cells.push(cur); cur = ''; }
        else { cur += c; }
    }
    cells.push(cur);
    return cells.map(c => c.trim().replace(/^"|"$/g, ''));
}

function parseCsv(text) {
    const txt = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = txt.split('\n').filter(l => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };

    // Detect delimiter
    const firstLine = lines[0];
    let delim = ',';
    if (firstLine.includes(';') && !firstLine.includes(',')) delim = ';';

    const headers = splitCsvLine(firstLine, delim);
    const rows = lines.slice(1).map(l => {
        const cells = splitCsvLine(l, delim);
        const r = {};
        headers.forEach((h, i) => { r[h] = cells[i] || ''; });
        return r;
    });
    return { headers, rows };
}

function parseDec(raw) {
    if (!raw || !raw.trim() || raw.trim() === '-') return null;
    const n = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim() || null; }

function normalise(raw, sourceUrl, commodity) {
    // Header names vary slightly across years — try multiple candidates
    const get = (...keys) => {
        const rowKeys = Object.keys(raw);
        for (const k of keys) {
            const found = rowKeys.find(rk => rk.toLowerCase().includes(k.toLowerCase()));
            if (found && raw[found]?.trim()) return raw[found].trim();
        }
        return null;
    };

    return {
        commodity: commodity === 'E' ? 'luce' : 'gas',
        fornitore: clean(get('ragione_sociale', 'ragione sociale', 'denominazione_venditore')),
        partitaIva: get('partita_iva', 'p_iva', 'piva'),
        codiceFiscale: get('codice_fiscale'),
        sitoWeb: get('sito_web'),
        numeroVerde: get('numero_verde'),
        nomeOfferta: clean(get('denominazione_offerta', 'denominazione')),
        codiceOfferta: get('codice_offerta'),
        urlOfferta: get('url_offerta', 'url '),
        tipoCliente: get('tipo_cliente'),
        tipoPrezzo: get('tipo_prezzo'),
        canaliAttivazione: clean(get('canali_attivazione')),
        modalitaPagamento: clean(get('modalita_pagamento', 'modalità_pagamento')),
        dataInizio: get('data_inizio'),
        dataFine: get('data_fine'),
        spesaAnnuaEur: parseDec(get('spesa_annua')),
        prezzoMonorarioEurKwh: parseDec(get('prezzo_monorario', 'monorario')),
        prezzoF1EurKwh: parseDec(get('prezzo_f1')),
        prezzoF2EurKwh: parseDec(get('prezzo_f2')),
        prezzoF3EurKwh: parseDec(get('prezzo_f3')),
        prezzoF23EurKwh: parseDec(get('prezzo_f23')),
        fonte: sourceUrl,
        scrapedAt: new Date().toISOString(),
    };
}

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories = ['luce', 'gas'],
    tipoCliente = '',
    tipoPrezzo = '',
    fornitoreFilter = '',
    maxItems = 0,
} = input;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/csv,application/csv,text/plain,application/xml,*/*',
    'Accept-Language': 'it-IT,it;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page',
};

let savedCount = 0;
const limit = maxItems > 0 ? maxItems : Infinity;

for (const cat of categories) {
    if (savedCount >= limit) break;
    const commodity = cat === 'luce' ? 'E' : cat === 'gas' ? 'G' : null;
    if (!commodity) continue;

    // Find latest PLACET CSV
    const url = await findLatestFile(commodity, 'PLACET', HEADERS);
    if (!url) {
        log.error(`No ${cat} CSV available — skipping`);
        continue;
    }

    log.info(`[${cat}] Downloading: ${url}`);
    let csvText;
    try {
        csvText = await downloadText(url, HEADERS);
    } catch (e) {
        log.error(`[${cat}] Download failed: ${e.message}`);
        continue;
    }
    log.info(`[${cat}] Downloaded ${csvText.length} chars`);

    const { rows, headers } = parseCsv(csvText);
    log.info(`[${cat}] Parsed ${rows.length} rows`);
    log.info(`[${cat}] Headers (${headers.length}): ${headers.join(' | ')}`);
    if (rows[0]) log.info(`[${cat}] First row sample: ${JSON.stringify(Object.fromEntries(Object.entries(rows[0]).slice(0, 10)))}`);

    let catCount = 0;
    for (const raw of rows) {
        if (savedCount >= limit) break;
        const rec = normalise(raw, url, commodity);

        if (tipoCliente && !(rec.tipoCliente || '').toLowerCase().includes(tipoCliente.toLowerCase())) continue;
        if (tipoPrezzo && !(rec.tipoPrezzo || '').toLowerCase().includes(tipoPrezzo.toLowerCase())) continue;
        if (fornitoreFilter && !(rec.fornitore || '').toLowerCase().includes(fornitoreFilter.toLowerCase())) continue;
        if (!rec.fornitore && !rec.nomeOfferta) continue;

        await Actor.pushData(rec);
        savedCount++;
        catCount++;
    }
    log.info(`[${cat}] Saved ${catCount} offers`);
}

log.info(`Done. Total saved: ${savedCount}`);
await Actor.exit();
