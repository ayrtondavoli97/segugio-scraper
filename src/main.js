import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';
const URLS = {
    luce: `${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`,
    gas: `${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`,
};

function toNumber(value) {
    if (!value) return null;
    const m = String(value).replace(/\s/g, '').match(/\d+(?:[.,]\d+)?/);
    return m ? Number(m[0].replace