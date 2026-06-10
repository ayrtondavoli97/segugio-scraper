/**
 * Diagnostic actor v3.0.0 — identify what's blocking access
 *
 * Tests multiple network strategies to determine the exact block mechanism:
 *   1. Plain fetch (no proxy)
 *   2. Apify DATACENTER proxy
 *   3. Apify RESIDENTIAL proxy
 *   4. Apify RESIDENTIAL + country=IT
 *   5. curl_cffi-style Chrome TLS via gotScraping with full Chrome headers
 *
 * For each: logs HTTP status, response size, and first 300 chars of body.
 */

import { Actor, log } from 'apify';
import { gotScraping } from 'crawlee';

const TARGET = 'https://www.ilportaleofferte.it/portaleOfferte/resources/opendata/csv/offerte/2026_5/PO_Offerte_E_PLACET_20260506.csv';

const CHROME_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page',
};

async function probe(label, proxyUrl, extraHeaders = {}) {
    log.info(`━━━ [${label}] ${proxyUrl ? 'proxy: ' + proxyUrl.replace(/:[^:@]+@/, ':***@') : 'NO PROXY'}`);
    try {
        const opts = {
            url: TARGET,
            method: 'GET',
            headers: { ...CHROME_HEADERS, ...extraHeaders },
            timeout: { request: 20000 },
            throwHttpErrors: false,
            decompress: true,
            followRedirect: true,
        };
        if (proxyUrl) opts.proxyUrl = proxyUrl;

        const res = await gotScraping(opts);
        const status = res.statusCode;
        const bodyLen = (res.body || '').length;
        const sample = (res.body || '').slice(0, 300).replace(/\s+/g, ' ').trim();
        const cfRay = res.headers['cf-ray'] || res.headers['cf-cache-status'] || null;
        const server = res.headers['server'] || null;

        log.info(`  → status=${status} bytes=${bodyLen} server="${server}" cf-ray=${cfRay}`);
        log.info(`  → body sample: ${sample}`);

        await Actor.pushData({
            test: label,
            status,
            bytes: bodyLen,
            server,
            cfRay,
            success: status === 200 && bodyLen > 1000,
            sample,
        });

        return { status, bodyLen, success: status === 200 && bodyLen > 1000 };
    } catch (e) {
        log.error(`  → ERROR: ${e.message}`);
        await Actor.pushData({ test: label, error: e.message });
        return { error: e.message };
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();

log.info(`Target URL: ${TARGET}`);
log.info('Running 5 diagnostic tests...\n');

// Test 1: no proxy
await probe('1-NO-PROXY', null);

// Test 2: DATACENTER proxy
try {
    const dcCfg = await Actor.createProxyConfiguration({ useApifyProxy: true });
    const dcUrl = await dcCfg.newUrl();
    await probe('2-DATACENTER', dcUrl);
} catch (e) {
    log.warning(`Datacenter proxy unavailable: ${e.message}`);
}

// Test 3: RESIDENTIAL proxy
try {
    const resCfg = await Actor.createProxyConfiguration({
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
    });
    const resUrl = await resCfg.newUrl();
    await probe('3-RESIDENTIAL', resUrl);
} catch (e) {
    log.warning(`Residential proxy unavailable: ${e.message}`);
}

// Test 4: RESIDENTIAL + country=IT
try {
    const itCfg = await Actor.createProxyConfiguration({
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'IT',
    });
    const itUrl = await itCfg.newUrl();
    await probe('4-RESIDENTIAL-IT', itUrl);
} catch (e) {
    log.warning(`Residential IT proxy unavailable: ${e.message}`);
}

// Test 5: DATACENTER + country=IT
try {
    const dcItCfg = await Actor.createProxyConfiguration({
        useApifyProxy: true,
        apifyProxyCountry: 'IT',
    });
    const dcItUrl = await dcItCfg.newUrl();
    await probe('5-DATACENTER-IT', dcItUrl);
} catch (e) {
    log.warning(`Datacenter IT proxy unavailable: ${e.message}`);
}

log.info('━━━ DIAGNOSTIC COMPLETE — check dataset for results');
await Actor.exit();
