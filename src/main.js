/**
 * Italy Luce & Gas Offers Scraper
 *
 * Scrapes public electricity, gas and dual-fuel offers from tariffe.segugio.it.
 * Focused only on the Italian energy market: luce, gas, luce-gas.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce: {
        label: 'Electricity',
        commodity: 'electricity',
        urls: [`${BASE}/costo-