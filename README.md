# UseCOS MCP Server (`usecos-mcp`)

Official Model Context Protocol (MCP) server for [UseCOS](https://usecos.app) — deterministic, zero-tracking Canadian financial, tax, mortgage, automotive, and ISO 3779 VIN calculations.

All calculations run locally using the exact open-source TypeScript engines powering `usecos.app`. No API keys, no user data collection, and no LLM guesswork on financial math.

## Tools Included

| Tool | What it calculates | Interactive Web Tool & Methodology |
|---|---|---|
| `calculate_canadian_mortgage` | Canadian semi-annual compounding payment, CMHC default insurance, provincial land transfer tax, and OSFI B-20 stress-test payment (`max(rate + 2%, 5.25%)`). | [usecos.app/mortgage](https://usecos.app/mortgage) |
| `compare_mortgage_renewals` | Side-by-side Canadian mortgage renewal offer comparison (scheduled payment, term interest, principal paid, ending balance, net switching cost, total term cost). | [usecos.app/mortgage/renewal-offer-analyzer](https://usecos.app/mortgage/renewal-offer-analyzer) |
| `calculate_canadian_paycheck` | Federal and provincial income tax, CPP/CPP2, EI/QPIP, Ontario surtax/health premium, and take-home pay for all 13 Canadian provinces and territories. | [usecos.app/pay](https://usecos.app/pay) · [Methodology](https://usecos.app/methodology/paycheck-calculator-validation) |
| `calculate_canadian_gst_hst` | Add or reverse-extract GST, PST, and HST across all 13 Canadian provinces and territories. | [usecos.app/gst](https://usecos.app/gst) |
| `calculate_canadian_auto_loan` | Auto loan monthly payment, sales tax after trade-in, net trade-in equity, and total interest. | [usecos.app/auto-loan-calculator-canada](https://usecos.app/auto-loan-calculator-canada) |
| `validate_iso_vin` | 17-character ISO 3779 / US 49 CFR Part 565 VIN check-digit validation (Position 9 Modulo-11), WMI, model year, and plant code decoding. | [usecos.app/vin](https://usecos.app/vin) |

## Quick Start

### Claude Desktop / Cursor / Windsurf

Add `usecos` to your MCP configuration:

```json
{
  "mcpServers": {
    "usecos": {
      "command": "npx",
      "args": ["-y", "usecos-mcp"]
    }
  }
}
```

### Run from source

```bash
node dist/index.js
```

## Disclaimers & Scope

Results are deterministic estimates based on published statutory formulas (Interest Act semi-annual compounding, OSFI B-20, CRA payroll formulas, ISO 3779). They do not replace a lender's commitment, tax professional advice, or a full vehicle history report.
