# Italy Luce & Gas Offers — Official ARERA Open Data 💡⚡

**Extract all active Italian electricity and gas offers from the official ARERA Portale Offerte open data.**

Source: [www.ilportaleofferte.it](https://www.ilportaleofferte.it/portaleOfferte/it/open-data.page) — Acquirente Unico S.p.A.
License: CC-BY — public open data, free to reuse commercially.

---

## Why this actor

The **Portale Offerte** is the official Italian price comparison portal regulated by ARERA (Italian Energy Regulator). By law, every Italian electricity and gas supplier must publish their active offers here. The data is released as daily CSV/XML files containing **all offers from all suppliers** — domestic and business, PLACET and Mercato Libero.

Until now, accessing this data programmatically required parsing files manually. This actor does it for you in seconds.

---

## What you get

| Field | Description |
|---|---|
| `commodity` | `luce` (electricity) or `gas` |
| `fornitore` | Supplier company name |
| `nomeOfferta` | Offer name (e.g. "PLACET LUCE FISSO DOMESTICO") |
| `tipoCliente` | Customer type: domestico / non domestico |
| `tipoPrezzo` | Price type: fisso (fixed) / variabile (variable) |
| `spesaAnnuaEur` | Estimated annual cost in EUR |
| `prezzoMonorarioEurKwh` | Single-rate price (€/kWh) |
| `prezzoF1EurKwh` | Peak hours price (F1, €/kWh) |
| `prezzoF2EurKwh` | Mid-peak hours price (F2, €/kWh) |
| `prezzoF3EurKwh` | Off-peak hours price (F3, €/kWh) |
| `canaliAttivazione` | How to activate (web, phone, store) |
| `modalitaPagamento` | Accepted payment methods |
| `dataInizio` / `dataFine` | Validity period |
| `urlOfferta` | Direct link to the offer page |
| `sitoWeb` | Supplier website |
| `numeroVerde` | Toll-free phone |
| `partitaIva` | Supplier VAT number |

---

## Input

| Parameter | Default | Description |
|---|---|---|
| `categories` | `["luce","gas"]` | Categories to scrape |
| `tipoCliente` | `""` | Filter: domestico / non domestico |
| `tipoPrezzo` | `""` | Filter: fisso / variabile |
| `fornitoreFilter` | `""` | Partial match on supplier name |
| `maxItems` | `0` | Max results (0 = all) |

---

## Example use cases

- **Energy brokers & comparison sites** — get fresh daily data on all Italian offers
- **Fintech apps** — feed live price comparison engines
- **Researchers** — analyse market structure, price evolution, supplier coverage
- **Lead generators** — identify suppliers active in specific segments
- **Consumer advocates** — track the cheapest offers across regions

---

## Source & legal

- **Source URL pattern:** `ilportaleofferte.it/.../resources/opendata/csv/offerte/{YYYY}_{N}/PO_Offerte_{E|G}_PLACET_{YYYYMMDD}.csv`
- **Publisher:** Acquirente Unico S.p.A. (ARERA designated body)
- **Update frequency:** daily
- **License:** [CC-BY](https://creativecommons.org/licenses/by/4.0/) — open data
- **Legal basis:** Legge Concorrenza 2017

Schedule daily (`0 9 * * *`) to keep your dataset current.

---

## Author

**Francesco Davoli** — [ayrtondavoli97](https://apify.com/ayrtondavoli97)
Italian market data scrapers — energy, pharma, real estate, public procurement.
