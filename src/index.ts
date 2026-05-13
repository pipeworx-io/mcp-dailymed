interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * DailyMed MCP — FDA Structured Product Labels via NLM
 *
 * No auth. JSON via `?format=json` (default for v2 endpoints).
 * Docs: https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm
 */


const BASE = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_drugs',
    description: 'Search Structured Product Labels by any combination of name, ANDA/NDA, NDC, RxCUI.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drug name (brand or generic)' },
        application_number: { type: 'string', description: 'ANDA/NDA number (e.g. "NDA021436")' },
        ndc: { type: 'string', description: 'NDC code (11-digit)' },
        rxcui: { type: 'string', description: 'RxNorm RxCUI' },
        manufacturer: { type: 'string', description: 'Manufacturer name' },
        page: { type: 'number', description: '1-based page (default 1)' },
        pagesize: { type: 'number', description: '1-100 (default 25)' },
      },
    },
  },
  {
    name: 'get_drug',
    description: 'Full SPL metadata + sections (e.g. dosage, warnings) by set_id.',
    inputSchema: {
      type: 'object',
      properties: { set_id: { type: 'string', description: 'DailyMed setId UUID' } },
      required: ['set_id'],
    },
  },
  {
    name: 'list_labels_for_drug_name',
    description: 'All labels mentioning a drug name.',
    inputSchema: {
      type: 'object',
      properties: {
        drug_name: { type: 'string' },
        page: { type: 'number' },
        pagesize: { type: 'number' },
      },
      required: ['drug_name'],
    },
  },
  {
    name: 'recent_updates',
    description: 'Recently updated labels.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '1-100 (default 25)' } },
    },
  },
  {
    name: 'list_classes',
    description: 'Pharmacologic / drug-class reference (EPC, MoA, PE, CS).',
    inputSchema: {
      type: 'object',
      properties: {
        class_code: { type: 'string', description: 'Restrict to a specific class code' },
        type: { type: 'string', description: 'EPC | MoA | PE | CS' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_drugs': {
      const params = new URLSearchParams();
      if (args.name) params.set('drug_name', String(args.name));
      if (args.application_number) params.set('application_number', String(args.application_number));
      if (args.ndc) params.set('ndc', String(args.ndc));
      if (args.rxcui) params.set('rxcui', String(args.rxcui));
      if (args.manufacturer) params.set('manufacturer', String(args.manufacturer));
      params.set('page', String(Math.max(1, (args.page as number) ?? 1)));
      params.set('pagesize', String(Math.min(100, Math.max(1, (args.pagesize as number) ?? 25))));
      return dailymedGet(`/spls.json?${params}`);
    }
    case 'get_drug':
      return dailymedGet(`/spls/${encodeURIComponent(reqStr(args, 'set_id', '"abc123-..."'))}.json`);
    case 'list_labels_for_drug_name': {
      const params = new URLSearchParams({
        drug_name: reqStr(args, 'drug_name', '"ibuprofen"'),
        page: String(Math.max(1, (args.page as number) ?? 1)),
        pagesize: String(Math.min(100, Math.max(1, (args.pagesize as number) ?? 25))),
      });
      return dailymedGet(`/spls.json?${params}`);
    }
    case 'recent_updates': {
      const params = new URLSearchParams({
        pagesize: String(Math.min(100, Math.max(1, (args.limit as number) ?? 25))),
      });
      return dailymedGet(`/spls.json?${params}`);
    }
    case 'list_classes': {
      const params = new URLSearchParams();
      if (args.class_code) params.set('class_code', String(args.class_code));
      if (args.type) params.set('type', String(args.type));
      return dailymedGet(`/pharmacologic_classes.json?${params}`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function dailymedGet(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'pipeworx-mcp-dailymed/1.0 (+https://pipeworx.io)',
    },
  });
  if (res.status === 404) throw new Error('DailyMed: not found');
  if (res.status === 429) throw new Error('DailyMed: rate-limit (HTTP 429)');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DailyMed error: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
