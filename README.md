# @pipeworx/dailymed

DailyMed MCP — official FDA-submitted drug labels via NLM's DailyMed service. ~150k Structured Product Labels. No auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `search_drugs(name?, application_number?, ndc?, rxcui?, page?, pagesize?)` — search labels
- `get_drug(set_id)` — Structured Product Label metadata + sections
- `list_labels_for_drug_name(drug_name, page?)` — all labels mentioning a drug name
- `recent_updates(limit?)` — recently updated labels
- `list_classes(class_code?, type?)` — pharmacologic / drug class reference

## Data source

`https://dailymed.nlm.nih.gov/dailymed/services/v2/` — REST + JSON.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "dailymed": {
      "url": "https://gateway.pipeworx.io/dailymed/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Dailymed data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
