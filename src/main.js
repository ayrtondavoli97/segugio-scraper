/**
 * Italy Luce & Gas Offers Scraper v2.0.0
 *
 * Data source: ARERA Portale Offerte open data
 *   https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page
 *
 * The Italian Energy Authority (ARERA via Acquirente Unico SpA) publishes
 * daily CSV/XML files containing ALL active electricity and gas offers
 * from ALL Italian energy suppliers. Public data, no auth, no antibot.
 *
 * URL pattern (CSV — PLACET):
 *   /resources/opendata/csv/offerte/{YYYY}_{N}/PO_Offerte_{E|G}_PLACET_{YYYYMMDD}.csv
 *
 * URL pattern (XML — Mercato Libero, richer data):
 *   /resources/opendata/csv/offerteML/{YYYY}_{N}/PO_Offerte_{E|G}_MLIBERO_{YYYYMMDD}.xml
 *
 * N = quarter number (1-4) where YYYYMMDD falls
 *
 * Files are typically published daily. We search backwards from today
 * until we find an available file (typically 1-3 days old).
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'crawlee';

const BASE = 'https://www.ilportaleofferte.it/portaleOfferte/resources/opendata/csv';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(date) {
    const y  = date.getFullYear();
    const m  = String(date.getMonth() + 1).padStart(2, '0');
    const d  = String(date.getDate()).padStart(2, '0');
    return { y, m, d, ymd: `${y}${m}${d}` };
}

/** Get quarter number (1-4) for a given month */
function getQuarter(month1to12) {
    return Math.ceil(month1to12 / 4); // 1-3 → 1, 4-6 → 2, 7-9 → 3, 10-12 → 4
}

/**
 * Build PLACET CSV URL.
 * Commodity: 'E' (electricity) or 'G' (gas)
 */
function buildPlacetUrl(date, commodity) {
    const { y, m, ymd } = formatDate(date);
    // ARERA splits into quarters but seems to use months sequentially in URL
    // From samples: 2023_1 = Jan, 2023_2 = Feb, 2024_1 = Jan, 2025_3 = March
    // So the "N" is actually MONTH-NUMBER not quarter
    const monthNum = parseInt(m, 10);
    return `${BASE}/offerte/${y}_${monthNum}/PO_Offerte_${commodity}_PLACET_${ymd}.csv`;
}

/** Parse Italian decimal: "0,123456" → 0.123456 */
function parseDec(raw) {
    if (!raw || !raw.trim() || raw.trim() === '-') return null;
    const n = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
}

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim() || null; }

/**
 * Try to fetch the CSV. Returns { url, text } on success, null on 404.
 */
async function tryFetch(url, headers) {
    try {
        const res = await gotScraping({
            url, headers,
            timeout: { request: 30000 },
            throwHttpErrors: false,
        });
        if (res.statusCode === 200 && res.body && res.body.length > 500) {
            return { url, text: res.body, status: 200 };
        }
        log.debug(`  ${url} → HTTP ${res.statusCode} (body ${res.body?.length ?? 0})`);
        return null;
    } catch (e) {
        log.debug(`  ${url} → ERROR ${e.message}`);
        return null;
    }
}

/**
 * Search backwards from today for the most recent available CSV.
 * ARERA publishes files at variable intervals — we try up to 60 days back.
 */
async function findLatestCsv(commodity, headers) {
    const today = new Date();
    log.info(`Searching for latest ${commodity === 'E' ? 'electricity' : 'gas'} PLACET file...`);

    for (let daysBack = 0; daysBack < 60; daysBack++) {
        const d   = new Date(today);
        d.setDate(d.getDate() - daysBack);
        const url = buildPlacetUrl(d, commodity);
        const res = await tryFetch(url, headers);
        if (res) {
            log.info(`✅ Found CSV: ${url} (${daysBack} days back)`);
            return res;
        }
        // Also try with different month-number heuristics — ARERA seems inconsistent
        // (quarter vs month). Let's also try quarter-based path.
        const { y } = formatDate(d);
        const q     = Math.ceil((d.getMonth() + 1) / 3);
        const urlQ  = `${BASE}/offerte/${y}_${q}/PO_Offerte_${commodity}_PLACET_${formatDate(d).ymd}.csv`;
        if (urlQ !== url) {
            const resQ = await tryFetch(urlQ, headers);
            if (resQ) {
                log.info(`✅ Found CSV (quarter path): ${urlQ}`);
                return resQ;
            }
        }
    }
    return null;
}

/**
 * Parse ARERA CSV (comma-delimited, header row).
 *
 * Confirmed columns from sample (2023):
 *   ragione_sociale, partita_iva, codice_fiscale, sito_web, numero_verde,
 *   denominazione_offerta, codice_offerta, url_offerta,
 *   canali_attivazione, modalita_pagamento,
 *   data_inizio_validita, data_fine_validita,
 *   tipo_cliente, tipo_prezzo,
 *   spesa_annua, prezzo_F1, prezzo_F2, prezzo_F3, prezzo_monorario,
 *   prezzo_F23, [others]
 *
 * Cells may contain quoted values with commas inside.
 */
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
    const headers = splitCsvLine(lines[0]);
    const rows = lines.slice(1).map(l => {
        const cells = splitCsvLine(l);
        const r = {};
        headers.forEach((h, i) => { r[h] = cells[i] || ''; });
        return r;
    });
    return { headers, rows };
}

/**
 * Normalise an ARERA row to clean output schema.
 * Tries multiple header naming conventions seen across years.
 */
function normalise(raw, sourceUrl, commodity) {
    const get = (...keys) => {
        for (const k of keys) {
            for (const rk of Object.keys(raw)) {
                if (rk.toLowerCase().includes(k.toLowerCase())) {
                    const v = (raw[rk] || '').trim();
                    if (v) return v;
                }
            }
        }
        return null;
    };

    const tipoPrezzo  = get('tipo_prezzo', 'tipo prezzo', 'tipologia');
    const tipoCliente = get('tipo_cliente', 'tipo cliente', 'cliente');
    const spesaAnnua  = parseDec(get('spesa_annua', 'spesa annua'));
    const prezzoF1    = parseDec(get('prezzo_f1', 'prezzo f1'));
    const prezzoF2    = parseDec(get('prezzo_f2', 'prezzo f2'));
    const prezzoF3    = parseDec(get('prezzo_f3', 'prezzo f3'));
    const prezzoMono  = parseDec(get('prezzo_monorario', 'monorario'));
    const prezzoF23   = parseDec(get('prezzo_f23', 'prezzo f23'));

    return {
        commodity:         commodity === 'E' ? 'luce' : 'gas',
        fornitore:         clean(get('ragione_sociale', 'ragione sociale')),
        partitaIva:        get('partita_iva', 'p_iva', 'piva'),
        codiceFiscale:     get('codice_fiscale', 'cf'),
        sitoWeb:           get('sito_web', 'sito'),
        numeroVerde:       get('numero_verde', 'verde'),
        nomeOfferta:       clean(get('denominazione_offerta', 'denominazione')),
        codiceOfferta:     get('codice_offerta', 'codice'),
        urlOfferta:        get('url_offerta', 'url'),
        tipoCliente,
        tipoPrezzo,
        canaliAttivazione: clean(get('canali_attivazione', 'canale')),
        modalitaPagamento: clean(get('modalita_pagamento', 'pagamento')),
        dataInizio:        get('data_inizio_validita', 'data_inizio', 'inizio'),
        dataFine:          get('data_fine_validita', 'data_fine', 'fine'),
        spesaAnnuaEur:     spesaAnnua,
        prezzoMonorarioEurKwh: prezzoMono,
        prezzoF1EurKwh:    prezzoF1,
        prezzoF2EurKwh:    prezzoF2,
        prezzoF3EurKwh:    prezzoF3,
        prezzoF23EurKwh:   prezzoF23,
        fonte:             sourceUrl,
        scrapedAt:         new Date().toISOString(),
    };
}

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories     = ['luce', 'gas'],
    tipoCliente    = '',  // 'domestico' | 'non domestico' | '' (all)
    tipoPrezzo     = '',  // 'fisso' | 'variabile' | '' (all)
    fornitoreFilter = '', // partial match on ragione_sociale
    maxItems       = 0,
} = input;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/csv,application/csv,text/plain,*/*',
    'Accept-Language': 'it-IT,it;q=0.9',
};

let savedCount = 0;
const limit = maxItems > 0 ? maxItems : Infinity;

for (const cat of categories) {
    if (savedCount >= limit) break;
    const commodity = cat === 'luce' ? 'E' : cat === 'gas' ? 'G' : null;
    if (!commodity) { log.warning(`Unknown category: ${cat}`); continue; }

    const fetched = await findLatestCsv(commodity, HEADERS);
    if (!fetched) {
        log.error(`No CSV available for ${cat} in last 60 days`);
        continue;
    }

    const { rows, headers } = parseCsv(fetched.text);
    log.info(`[${cat}] Parsed ${rows.length} rows`);
    log.info(`[${cat}] CSV headers (${headers.length}): ${headers.slice(0, 15).join(' | ')}`);
    if (rows[0]) log.info(`[${cat}] First row sample: ${JSON.stringify(Object.fromEntries(Object.entries(rows[0]).slice(0, 8)))}`);

    let catCount = 0;
    for (const raw of rows) {
        if (savedCount >= limit) break;
        const rec = normalise(raw, fetched.url, commodity);

        // Filters
        if (tipoCliente && !(rec.tipoCliente || '').toLowerCase().includes(tipoCliente.toLowerCase())) continue;
        if (tipoPrezzo  && !(rec.tipoPrezzo  || '').toLowerCase().includes(tipoPrezzo.toLowerCase()))  continue;
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
