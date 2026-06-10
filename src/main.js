/**
 * Italy Luce & Gas Offers Scraper
 *
 * Scrapes public electricity and gas offer pages from tariffe.segugio.it.
 * The extraction is intentionally defensive: Segugio markup can change, so the
 * actor combines semantic selectors, text heuristics and optional debug output.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';

const BASE_URL = 'https://tariffe.segugio.it';

const CATEGORY_CONFIG = {
    luce: {
        label: 'luce',
        urls: [