/**
 * Italy Luce & Gas Offers Scraper
 *
 * Scrapes public electricity, gas and dual-fuel offers from tariffe.segugio.it.
 * Output is normalized for market monitoring, lead generation, price tracking,
 * comparison tools and commercial datasets.
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';

const CATEGORY_URLS = {
    luce: {
        label: 'Electricity',