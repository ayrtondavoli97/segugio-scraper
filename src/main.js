import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';
const URLS = {
  luce: [`${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`],
  gas: [
    `${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`,
    `${BASE}/costo-gas-metano/lista-offerte-gas.aspx`,
    `${BASE}/costo-gas/lista-offerte-gas.aspx`,
  ],
  'luce-gas': [
    `${BASE}/costo-luce