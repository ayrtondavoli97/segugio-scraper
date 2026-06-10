import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';

const BASE = 'https://tariffe.segugio.it';
const CATS = {
  luce: [
    `${BASE}/costo-energia-elettrica/lista-offerte-energia-elettrica.aspx`,
  ],
  gas: [
    `${BASE}/costo-gas-metano/lista-offerte-gas-metano.aspx`,
    `${BASE}/costo-gas-metano/lista-offerte-gas.aspx`,
    `${BASE}/costo-gas/lista-offerte-gas.aspx`,
  ],
  'luce-gas': [
    `${BASE}/costo-luce-gas/lista-offerte-luce-gas.aspx`,
    `${BASE}/costo-energia-elettrica-gas/lista-offerte-luce-gas.aspx`,
  ],
};
const DEFAULT_INPUT = {
  categories: ['luce', 'gas'],
  maxItems: 50