/**
 * Italy Luce & Gas Offers Scraper
 * Scrapes public electricity, gas and dual-fuel offers from tariffe.segugio.it.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`],
    gas: [`${BASE}/costo-gas-metano/lista-off