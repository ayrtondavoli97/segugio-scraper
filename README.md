# Segugio.it Scraper — Energy, Internet & Mobile Offers Italy 🔌📱

**Scrape all publicly listed offers from Segugio.it** — Italy's #1 price comparison portal for energy, internet, and mobile plans.

---

## What it scrapes

| Category | Source | What you get |
|---|---|---|
| **Electricity** (luce) | tariffe.segugio.it | Provider, price/kWh, monthly cost, fixed/variable |
| **Gas** | tariffe.segugio.it | Provider, price/Smc, monthly cost, contract type |
| **Electricity + Gas** (dual fuel) | tariffe.segugio.it | Combined offers from major providers |
| **Internet / Fiber** | tariffe.segugio.it | Provider, speed, monthly price, activation cost |
| **Mobile** | tariffe.segugio.it | Operator, GB data, calls, monthly price |

---

## Output fields

| Field | Description |
|---|---|
| `categoria` | Category: `luce`, `gas`, `luce-gas`, `internet`, `mobile` |
| `fornitore` | Provider name (e.g. Enel Energia, Edison, Sorgenia, Tim, Vodafone) |
| `nomeOfferta` | Offer name (e.g. "Web Luce", "Dynamic Gas", "Super Fibra 1Gb") |
| `prezzoMensileEur` | Estimated monthly cost in EUR |
| `prezzoCommodity` | Unit price as displayed (e.g. "0,122 €/kWh", "PUN + 0,014 €/kWh") |
| `unitaCommodity` | Unit (€/kWh for electricity, €/Smc for gas, €/mese for internet) |
| `quotaFissaEur` | Fixed monthly fee in EUR |
| `tipologiaPrezzo` | Price type: "Fisso 12 mesi", "Fisso 24 mesi", "Variabile" |
| `bonus` | Promotional bonuses (e.g. "Fino a 55€ di sconto") |
| `sponsorizzata` | Whether the offer is a paid placement |
| `urlOfferta` | Direct link to the offer on Segugio.it |
| `logoFornitore` | Provider logo URL |
| `fonte` | Source page URL |
| `scrapedAt` | ISO timestamp of scrape |

---

## Input options

| Parameter | Default | Description |
|---|---|---|
| `categories` | `["luce","gas","internet","mobile"]` | Categories to scrape |
| `includeSponsored` | `true` | Include paid/sponsored placements |
| `maxItems` | `0` | Max offers per category (0 = all) |
| `proxyConfig` | Apify proxy | Proxy configuration |

---

## Example use cases

- **Energy brokers & consultants** — monitor daily pricing across all Italian providers
- **Fintech / comparison apps** — feed a live pricing engine for Italy
- **Market researchers** — track price evolution over time (schedule daily)
- **Journalists / consumer advocates** — benchmark Italy's energy market
- **B2B leads** — identify which providers are most active in specific markets

---

## Providers covered

**Energy:** Enel Energia, Plenitude (ex Eni), Edison, Iren, Engie, Sorgenia, A2A Energia, Wekiwi, Illumia, Luce+Gas Italia and 30+ more

**Internet:** TIM, Vodafone, WindTre, Fastweb, Sky WiFi, Tiscali, Very Mobile Fiber and more

**Mobile:** TIM, Vodafone, WindTre, Iliad, Sky Mobile, ho. Mobile, Spusu, Fastweb Mobile and more

---

## Scheduling

Run daily to track price changes:
```
Cron: 0 7 * * *
```

---

## Author

**Francesco Davoli** — [ayrtondavoli97](https://apify.com/ayrtondavoli97)
Italian market data scrapers — energy, pharma, real estate, public procurement.
