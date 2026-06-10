/**
 * Italy Luce & Gas Offers Scraper v2.2.0
 *
 * Source: ARERA Portale Offerte open data
 * URL pattern: /opendata/csv/offerte/{YYYY}_{M}/PO_Offerte_{E|G}_PLACET_{YYYYMMDD}.csv
 *
 * v2.2 fixes:
 * - Use GET with Range: bytes=0-1023 instead of HEAD (some servers don't allow HEAD)
 * - Log status code of each attempt to diagnose what's actually returned
 * - Search 120 days back
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'crawlee';

const BASE = 'https://www.ilportaleofferte.it/portaleOfferte/resources/opendata/csv';

function pad(n) { return String(n).padStart(2, '0'); }
function dateToYmd(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}
function buildUrl(date, commodity, dataset = 'PLACET') {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const ymd = dateToYmd(date);
    const ext = dataset === 'MLIBERO' ? 'xml' : 'csv';
    const dir = dataset === 'MLIBERO' ? 'offerteML' : 'offerte';
    return `${BASE}/${dir}/${year}_${month}/PO_Offerte_${commodity}_${dataset}_${ymd}.${ext}`;
}

/** Probe URL with GET + Range header (1KB) to check existence */
async function probeUrl(url, headers) {
    try {
        const res = await gotScraping({
            url,
            method: 'GET',
            headers: { ...headers, 'Range': 'bytes=0-1023' },
            timeout: { request: 8000 },
            throwHttpErrors: false,
            followRedirect: true,
        });
        return { status: res.statusCode, bytes: (res.body || '').length, sample: (res.body || '').slice(0, 200) };
    } catch (e) {
        return { status: -1, bytes: 0, error: e.message };
    }
}

async function downloadText(url, headers) {
    const res = await gotScraping({
        url, headers,
        timeout: { request: 60000 },
        throwHttpErrors: false,
        decompress: true,
    });
    if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);
    return res.body;
}

async function findLatestFile(commodity, dataset, headers) {
    const today = new Date();
    log.info(`Searching for latest ${commodity}/${dataset} file (120 days back)...`);

    let firstStatus = null;
    let firstError = null;
    const statusCounts = {};

    for (let daysBack = 0; daysBack < 120; daysBack++) {
        const d = new Date(today);
        d.setDate(d.getDate() - daysBack);
        const url = buildUrl(d, commodity, dataset);
        const probe = await probeUrl(url, headers);

        statusCounts[probe.status] = (statusCounts[probe.status] || 0) + 1;

        // Log first 3 attempts in detail
        if (daysBack < 3) {
            log.info(`  [${daysBack}d] ${url.split('/').slice(-2).join('/')} → ${probe.status} (${probe.bytes}B) ${probe.sample.slice(0,80).replace(/\n/g, ' ')}`);
        }

        if (probe.status === 200 || probe.status === 206) {
            log.info(`✅ Found: ${url} (status ${probe.status}, ${daysBack} days back)`);
            return url;
        }

        if (firstStatus === null) {
            firstStatus = probe.status;
            firstError = probe.error;
        }
    }

    log.warning(`No file found. First status seen: ${firstStatus}${firstError ? ` (${firstError})` : ''}`);
    log.warning(`Status distribution over 120 attempts: ${JSON.stringify(statusCounts)}`);
    return null;
}

// ─── CSV parsing ──────────────────────────────────────────────────────────────

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

    const firstLine = lines[0];
    const delim = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
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
        fornitore: clean(get('ragione_sociale', 'denominazione_venditore')),
        partitaIva: get('partita_iva', 'p_iva'),
        codiceFiscale: get('codice_fiscale'),
        sitoWeb: get('sito_web'),
        numeroVerde: get('numero_verde'),
        nomeOfferta: clean(get('denominazione_offerta')),
        codiceOfferta: get('codice_offerta'),
        urlOfferta: get('url_offerta'),
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
    log.info(`[${cat}] Headers (${headers.length}): ${headers.slice(0, 20).join(' | ')}`);
    if (rows[0]) log.info(`[${cat}] First row: ${JSON.stringify(Object.fromEntries(Object.entries(rows[0]).slice(0, 8)))}`);

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
