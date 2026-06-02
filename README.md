# mcp-dailymed

DailyMed MCP — FDA Structured Product Labels via NLM

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 673+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_drugs` | Search Structured Product Labels by any combination of name, ANDA/NDA, NDC, RxCUI. |
| `get_drug` | Full SPL metadata + sections (e.g. dosage, warnings) by set_id. |
| `list_labels_for_drug_name` | All labels mentioning a drug name. |
| `recent_updates` | Recently updated labels. |
| `list_classes` | Pharmacologic / drug-class reference (EPC, MoA, PE, CS). |

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

Or connect to the full Pipeworx gateway for access to all 673+ data sources:

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

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
