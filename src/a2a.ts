import http from 'http';
import crypto from 'crypto';
import { GraphDB } from './storage';
import { getDbPath, loadConfig } from './config';
import type { A2AAgentCard, A2ARpcRequest, A2ARpcResponse, EdgeCost, NodeRecord } from './types';

const CARD_VERSION = '0.1.0';

export function getAgentCard(): A2AAgentCard {
  return {
    name: 'cgraph-a2a-adapter',
    version: CARD_VERSION,
    transport: 'http+jsonrpc',
    capabilities: [
      { name: 'register_agent', implemented: true, description: 'Register an agent capability claim signed with Ed25519.' },
      { name: 'write_node', implemented: true, description: 'Persist an agent-authored node into graph storage.' },
      { name: 'read_lineage', implemented: true, description: 'Return parent lineage for a node by traversing incoming references.' },
      { name: 'query_by_agent', implemented: true, description: 'Query node records authored by an agent.' },
    ],
  };
}

function rpcResult(id: string | number | null | undefined, result: unknown): A2ARpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown): A2ARpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function parseCost(value: unknown): EdgeCost {
  if (!value || typeof value !== 'object') return {};
  const c = value as Record<string, unknown>;
  return {
    tokens_in: typeof c.tokens_in === 'number' ? c.tokens_in : undefined,
    tokens_out: typeof c.tokens_out === 'number' ? c.tokens_out : undefined,
    latency_ms: typeof c.latency_ms === 'number' ? c.latency_ms : undefined,
    est_cost_usd: typeof c.est_cost_usd === 'number' ? c.est_cost_usd : undefined,
  };
}

type TrustMode = 'registration_only' | 'per_write';

interface TrustPolicy {
  mode: TrustMode;
  maxVerifyLatencyMs: number;
  allowFallback: boolean;
}

function agentNodePath(): string {
  return 'a2a/agents.json';
}

function agentQName(agentId: string): string {
  return `${agentNodePath()}::agent:${agentId}`;
}

function parseAgentTrust(doc: string | null): 'verified' | 'unverified' {
  if (!doc) return 'unverified';
  try {
    const parsed = JSON.parse(doc) as { trust_status?: string };
    return parsed.trust_status === 'verified' ? 'verified' : 'unverified';
  } catch {
    return 'unverified';
  }
}

function verifyEd25519Claim(claim: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length === 0) return false;
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(claim, 'utf-8'), key, signature);
  } catch {
    return false;
  }
}

function parseTrustMode(value: unknown): TrustMode | undefined {
  return value === 'registration_only' || value === 'per_write'
    ? value
    : undefined;
}

function getTrustPolicy(rootDir: string, params: Record<string, unknown>): TrustPolicy {
  const config = loadConfig(rootDir);
  const configuredMode = parseTrustMode(config.a2a?.trustMode);
  const requestedMode = parseTrustMode(params.trust_mode);
  const mode = requestedMode ?? configuredMode ?? 'registration_only';

  const configuredLatency = typeof config.a2a?.maxVerifyLatencyMs === 'number'
    ? config.a2a.maxVerifyLatencyMs
    : 10;
  const requestedLatency = typeof params.max_verify_latency_ms === 'number'
    ? params.max_verify_latency_ms
    : undefined;
  const maxVerifyLatencyMs = requestedLatency ?? configuredLatency;

  const configuredFallback = typeof config.a2a?.allowVerifyFallback === 'boolean'
    ? config.a2a.allowVerifyFallback
    : true;
  const requestedFallback = typeof params.allow_verify_fallback === 'boolean'
    ? params.allow_verify_fallback
    : undefined;
  const allowFallback = requestedFallback ?? configuredFallback;

  return {
    mode,
    maxVerifyLatencyMs,
    allowFallback,
  };
}

function getFilePathForNode(db: GraphDB, node: NodeRecord): string {
  const file = db.getFileById(node.file_id);
  return file?.path ?? '';
}

function findNodeByQuery(db: GraphDB, query: string): NodeRecord | undefined {
  const byQName = db.findNodeByQName(query);
  if (byQName) return byQName;
  const byName = db.findNodesByName(query);
  if (byName.length > 0) return byName[0];
  return undefined;
}

export async function handleA2ARpcRequest(rootDir: string, request: A2ARpcRequest): Promise<A2ARpcResponse> {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(request?.id, -32600, 'Invalid Request');
  }

  if (request.method === 'agent.card' || request.method === 'a2a.discover') {
    return rpcResult(request.id, getAgentCard());
  }

  if (request.method === 'register_agent') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    const claim = typeof params.claim === 'string' && params.claim.length > 0
      ? params.claim
      : undefined;
    const signature = typeof params.signature === 'string' && params.signature.length > 0
      ? params.signature
      : undefined;
    const publicKey = typeof params.public_key === 'string' && params.public_key.length > 0
      ? params.public_key
      : undefined;

    if (!agentId || !claim || !signature || !publicKey) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id", "claim", "signature", and "public_key" are required.');
    }

    const verified = verifyEd25519Claim(claim, signature, publicKey);
    if (!verified) {
      return rpcError(request.id, -32003, 'Signature verification failed for agent claim.');
    }

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const payload = {
        agent_id: agentId,
        public_key: publicKey,
        claim,
        signature,
        verified_at: new Date().toISOString(),
        trust_status: 'verified',
      };
      const hash = crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex');
      const file = db.upsertFile(agentNodePath(), hash, 'a2a', JSON.stringify(payload).length, Date.now(), true);
      const nodeId = db.insertNode(
        file.id,
        agentId,
        agentQName(agentId),
        'variable',
        1,
        1,
        'agent_registration',
        JSON.stringify(payload),
        true,
      );
      db.save();
      return rpcResult(request.id, {
        agent_id: agentId,
        registered: true,
        trust_status: 'verified',
        node_id: nodeId,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'write_node') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    const nodeName = typeof params.name === 'string' && params.name.length > 0
      ? params.name
      : undefined;

    if (!agentId || !nodeName) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id" and "name" are required.');
    }

    const kind = typeof params.kind === 'string' && params.kind.length > 0
      ? params.kind
      : 'variable';
    const exported = params.exported === true;
    const filePath = typeof params.file_path === 'string' && params.file_path.length > 0
      ? params.file_path
      : `a2a/${agentId}/${Date.now()}.json`;
    const qname = typeof params.qualified_name === 'string' && params.qualified_name.length > 0
      ? params.qualified_name
      : `${filePath}::${nodeName}`;

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const trustPolicy = getTrustPolicy(rootDir, params);
      const hashSeed = JSON.stringify({ agentId, nodeName, qname, ts: Date.now() });
      const hash = crypto.createHash('md5').update(hashSeed).digest('hex');
      const upserted = db.upsertFile(filePath, hash, 'a2a', hashSeed.length, Date.now(), true);
      const nodeId = db.insertNode(
        upserted.id,
        nodeName,
        qname,
        kind,
        typeof params.start_line === 'number' ? params.start_line : 1,
        typeof params.end_line === 'number' ? params.end_line : 1,
        typeof params.signature === 'string' ? params.signature : null,
        typeof params.doc === 'string' ? params.doc : null,
        exported,
      );

      const parentQName = typeof params.parent_qname === 'string' && params.parent_qname.length > 0
        ? params.parent_qname
        : undefined;
      const registeredAgent = db.findNodeByQName(agentQName(agentId));
      let trustStatus = registeredAgent
        ? parseAgentTrust(registeredAgent.doc)
        : 'unverified';
      let trustModeApplied: TrustMode = trustPolicy.mode;
      let fallbackTriggered = false;
      let verifyLatencyMs = 0;

      if (trustPolicy.mode === 'per_write') {
        const inlineClaim = typeof params.claim === 'string' && params.claim.length > 0
          ? params.claim
          : undefined;
        const inlineSignature = typeof params.signature === 'string' && params.signature.length > 0
          ? params.signature
          : undefined;
        const inlinePublicKey = typeof params.public_key === 'string' && params.public_key.length > 0
          ? params.public_key
          : undefined;

        if (!inlineClaim || !inlineSignature || !inlinePublicKey) {
          return rpcError(request.id, -32602, 'Invalid params: per_write trust mode requires "claim", "signature", and "public_key".');
        }

        const verifyStart = Date.now();
        const verified = verifyEd25519Claim(inlineClaim, inlineSignature, inlinePublicKey);
        verifyLatencyMs = Date.now() - verifyStart;

        if (!verified) {
          return rpcError(request.id, -32003, 'Signature verification failed for write_node in per_write mode.');
        }

        trustStatus = 'verified';

        if (verifyLatencyMs > trustPolicy.maxVerifyLatencyMs && trustPolicy.allowFallback) {
          fallbackTriggered = true;
          trustModeApplied = 'registration_only';
          trustStatus = registeredAgent ? parseAgentTrust(registeredAgent.doc) : 'unverified';
        }
      }

      if (parentQName) {
        const parent = db.findNodeByQName(parentQName);
        if (parent) {
          db.insertEdge(parent.id, nodeId, 'references', parseCost(params.cost));
        }
      }

      if (registeredAgent) {
        db.insertEdge(registeredAgent.id, nodeId, 'authored');
      }

      db.save();
      return rpcResult(request.id, {
        node_id: nodeId,
        file_path: filePath,
        qualified_name: qname,
        agent_id: agentId,
        trust_status: trustStatus,
        trust_mode_applied: trustModeApplied,
        verify_latency_ms: verifyLatencyMs,
        fallback_triggered: fallbackTriggered,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'read_lineage') {
    const params = request.params ?? {};
    const query = typeof params.qualified_name === 'string' && params.qualified_name.length > 0
      ? params.qualified_name
      : (typeof params.name === 'string' && params.name.length > 0 ? params.name : undefined);
    if (!query) {
      return rpcError(request.id, -32602, 'Invalid params: "qualified_name" or "name" is required.');
    }

    const maxDepth = typeof params.max_depth === 'number' ? params.max_depth : 3;
    const maxNodes = typeof params.max_nodes === 'number' ? params.max_nodes : 50;

    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const startNode = findNodeByQuery(db, query);
      if (!startNode) {
        return rpcError(request.id, -32001, `Node not found: ${query}`);
      }

      const visited = new Set<number>([startNode.id]);
      const queue: Array<{ id: number; depth: number }> = [{ id: startNode.id, depth: 0 }];
      const nodes: Array<{ id: number; qualified_name: string; name: string; kind: string; file_path: string; depth: number; doc: string | null }> = [];
      const edges: Array<{ source_id: number; target_id: number; kind: string }> = [];

      while (queue.length > 0 && nodes.length < maxNodes) {
        const current = queue.shift();
        if (!current) break;
        const record = db.getNode(current.id);
        if (!record) continue;

        nodes.push({
          id: record.id,
          qualified_name: record.qualified_name,
          name: record.name,
          kind: record.kind,
          file_path: getFilePathForNode(db, record),
          depth: current.depth,
          doc: record.doc,
        });

        if (current.depth >= maxDepth) continue;

        const incoming = db.getEdgesTo(record.id);
        for (const edge of incoming) {
          const sourceNode = db.getNode(edge.source_id);
          if (!sourceNode) continue;
          edges.push({ source_id: edge.source_id, target_id: edge.target_id, kind: edge.kind });
          if (!visited.has(sourceNode.id)) {
            visited.add(sourceNode.id);
            queue.push({ id: sourceNode.id, depth: current.depth + 1 });
          }
        }
      }

      return rpcResult(request.id, {
        target: startNode.qualified_name,
        max_depth: maxDepth,
        max_nodes: maxNodes,
        nodes,
        edges,
      });
    } finally {
      db.close();
    }
  }

  if (request.method === 'query_by_agent') {
    const params = request.params ?? {};
    const agentId = typeof params.agent_id === 'string' && params.agent_id.length > 0
      ? params.agent_id
      : undefined;
    if (!agentId) {
      return rpcError(request.id, -32602, 'Invalid params: "agent_id" is required.');
    }

    const limit = typeof params.limit === 'number' ? params.limit : 100;
    const db = await GraphDB.open(getDbPath(rootDir));
    try {
      const registration = db.findNodeByQName(agentQName(agentId));
      const authoredNodes: Array<{ id: number; name: string; qualified_name: string; kind: string; file_path: string; doc: string | null }> = [];

      if (registration) {
        const authoredEdges = db.getEdgesFrom(registration.id, 'authored');
        for (const edge of authoredEdges.slice(0, limit)) {
          const node = db.getNode(edge.target_id);
          if (!node) continue;
          authoredNodes.push({
            id: node.id,
            name: node.name,
            qualified_name: node.qualified_name,
            kind: node.kind,
            file_path: getFilePathForNode(db, node),
            doc: node.doc,
          });
        }
      }

      return rpcResult(request.id, {
        agent_id: agentId,
        registration_found: Boolean(registration),
        count: authoredNodes.length,
        nodes: authoredNodes,
      });
    } finally {
      db.close();
    }
  }

  return rpcError(request.id, -32601, `Method not found: ${request.method}`);
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function startA2AServer(rootDir: string, opts: { port?: number; host?: string } = {}): http.Server {
  const port = opts.port ?? 7071;
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      if (req.method === 'GET' && url === '/.well-known/agent-card.json') {
        const card = getAgentCard();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(card));
        return;
      }

      if (req.method === 'POST' && url === '/rpc') {
        const payload = await readJsonBody(req);
        const response = await handleA2ARpcRequest(rootDir, payload as A2ARpcRequest);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(response));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err: any) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message ?? 'Internal server error' }));
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(JSON.stringify({
      status: 'a2a_listening',
      host,
      port,
      card_url: `http://${host}:${port}/.well-known/agent-card.json`,
      rpc_url: `http://${host}:${port}/rpc`,
    }) + '\n');
  });

  return server;
}
