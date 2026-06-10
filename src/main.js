/**
 * Segugio.it Scraper v1.8.0
 *
 * Fix 407: pass proxy credentials as { server, username, password }
 * instead of embedding them in the URL.
 *
 * Fix 403 no-proxy: use RESIDENTIAL proxy which rotates IPs.
 */

import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce:       { urls: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`] },
    gas:        { urls: [`${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`] },
    'luce-gas': { urls: [`${BASE}/migliori-tariffe/migliori-tariffe-luce-gas.aspx`] },
    internet:   { urls: [`${BASE}/tariffe-adsl-internet/lista-offerte-adsl-internet.aspx`] },
    mobile:     { urls: [`${BASE}/tariffe-cellulari/`] },
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

/**
 * Parse proxy URL into Playwright proxy config object.
 * Playwright needs { server, username, password } separately — NOT credentials in URL.
 * http://user:pass@host:port → { server: 'http://host:port', username: 'user', password: 'pass' }
 */
function parseProxyUrl(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        const u = new URL(proxyUrl);
        return {
            server:   `${u.protocol}//${u.host}`,
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
        };
    } catch {
        return { server: proxyUrl };
    }
}

async function createContext(browser, proxyConfig) {
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'it-IT',
        extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8' },
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });
    // Block heavy/tracking resources to speed up
    await ctx.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,otf,ico}', r => r.abort());
    await ctx.route('**/{analytics,gtm,facebook,google-analytics,hotjar,doubleclick}**', r => r.abort());
    return ctx;
}

async function testProxy(browser, proxyConfig, label) {
    log.info(`Testing [${label}]...`);
    const ctx  = await createContext(browser, proxyConfig);
    const page = await ctx.newPage();
    try {
        const res = await page.goto('https://tariffe.segugio.it/', {
            waitUntil: 'commit',
            timeout: 20000,
        });
        const status  = res?.status();
        const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);
        log.info(`  HTTP ${status} | body ${bodyLen} chars`);
        if (status === 200 && bodyLen > 500) {
            log.info(`  ✅ [${label}] WORKS`);
            await page.close();
            return ctx; // return working context
        }
        log.warning(`  ❌ [${label}] status=${status} body=${bodyLen}`);
    } catch (e) {
        log.warning(`  ❌ [${label}] ${e.message.slice(0, 100)}`);
    }
    await page.close();
    await ctx.close();
    return null;
}

async function scrapePage(page, url, categoria, includeSponsored) {
    log.info(`[${categoria}] → ${url}`);

    const res     = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    const status  = res?.status();
    const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length ?? 0);
    log.info(`[${categoria}] HTTP ${status} | body ${bodyLen} chars`);

    if (bodyLen < 500) {
        log.warning(`[${categoria}] Body too small — blocked or empty`);
        return [];
    }

    // Wait for React to render offer cards
    try {
        await page.waitForSelector('img[title^="Logo di "]', { timeout: 20000 });
        log.info(`[${categoria}] ✅ Offers rendered`);
    } catch {
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(4000);
        const c = await page.locator('img[title^="Logo di "]').count();
        if (c === 0) {
            const txt = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) ?? '');
            log.warning(`[${categoria}] No offers found. Body:\n${txt}`);
            return [];
        }
    }

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
        log.info(`  first: "${rawOffers[0].fornitore}" lines=${JSON.stringify(rawOffers[0].lines.slice(0, 12))}`);
    }

    const offers = [];
    for (const raw of rawOffers) {
        const p = parseCardLines(raw.lines);
        if (!p.prezzoMensileEur && !p.prezzoCommodity) continue;
        if (!includeSponsored && p.sponsorizzata) continue;
        offers.push({
            categoria, fornitore: raw.fornitore,
            nomeOfferta: p.nomeOfferta, prezzoMensile: p.prezzoMensile,
            prezzoMensileEur: p.prezzoMensileEur, prezzoCommodity: p.prezzoCommodity,
            unitaCommodity: p.unitaCommodity, quotaFissa: p.quotaFissa,
            quotaFissaEur: p.quotaFissaEur, tipologiaPrezzo: p.tipologiaPrezzo,
            durataContratto: p.tipologiaPrezzo?.match(/(\d+)\s*mesi/i)?.[1] ?? null,
            bonus: p.bonus, esclusiva: p.esclusiva, sponsorizzata: p.sponsorizzata,
            urlOfferta: raw.urlOfferta, logoFornitore: raw.logoUrl,
            fonte: url, scrapedAt: new Date().toISOString(),
        });
    }
    return offers;
}

// ─── main ─────────────────────────────────────────────────────────────────────

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    categories       = ['luce'],
    includeSponsored = true,
    maxItems         = 0,
} = input;

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-blink-features=AutomationControlled'],
});

// Build proxy options with correct credential parsing
const proxyOptions = [];

try {
    const cfg = await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] });
    const url = await cfg.newUrl();
    proxyOptions.push({ label: 'RESIDENTIAL', config: parseProxyUrl(url) });
    log.info(`RESIDENTIAL URL: ${url.replace(/:[^:@]+@/, ':***@')}`);
} catch (e) { log.warning(`No RESIDENTIAL proxy: ${e.message}`); }

try {
    const cfg = await Actor.createProxyConfiguration({ useApifyProxy: true });
    const url = await cfg.newUrl();
    proxyOptions.push({ label: 'DATACENTER', config: parseProxyUrl(url) });
    log.info(`DATACENTER URL: ${url.replace(/:[^:@]+@/, ':***@')}`);
} catch (e) { log.warning(`No DATACENTER proxy: ${e.message}`); }

proxyOptions.push({ label: 'NO PROXY', config: null });

// Find working proxy
let workingContext = null;
for (const opt of proxyOptions) {
    const ctx = await testProxy(browser, opt.config, opt.label);
    if (ctx) { workingContext = ctx; break; }
}

if (!workingContext) {
    log.error('All proxy options failed');
    await browser.close();
    await Actor.exit();
}

const dataset    = await Dataset.open();
const seenGlobal = new Set();
let savedCount   = 0;
const limit      = maxItems > 0 ? maxItems * categories.length : Infinity;

for (const cat of categories) {
    const def = CATEGORY_URLS[cat];
    if (!def) continue;
    for (const url of def.urls) {
        const page = await workingContext.newPage();
        try {
            const offers = await scrapePage(page, url, cat, includeSponsored);
            for (const offer of offers) {
                if (savedCount >= limit) break;
                const key = `${offer.fornitore}||${offer.nomeOfferta}||${cat}`;
                if (seenGlobal.has(key)) continue;
                seenGlobal.add(key);
                await dataset.pushData(offer);
                savedCount++;
                log.info(`  ✅ [${savedCount}] ${offer.fornitore} — ${offer.nomeOfferta} — €${offer.prezzoMensileEur}/mese`);
            }
        } catch (e) {
            log.error(`[${cat}] ${e.message}`);
        } finally {
            await page.close();
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

await browser.close();
log.info(`Done. Total saved: ${savedCount}`);
await Actor.exit();
