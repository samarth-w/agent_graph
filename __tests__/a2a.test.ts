import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { PassThrough } from 'stream';
import { getAgentCard, handleA2ARpcRequest, readJsonBody, startA2AServer } from '../src/a2a';
import { GraphDB } from '../src/storage';
import { MemoryService } from '../src/memory';
import { getDbPath } from '../src/config';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-a2a-test-'));
}

describe('A2A adapter skeleton', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    MemoryService.closeForGraphPath(getDbPath(tempDir));
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an Agent Card with advertised capabilities', () => {
    const card = getAgentCard();
    expect(card.transport).toBe('http+jsonrpc');
    expect(card.capabilities.some(c => c.name === 'write_node' && c.implemented)).toBe(true);
    expect(card.capabilities.some(c => c.name === 'read_lineage' && c.implemented)).toBe(true);
    expect(card.capabilities.some(c => c.name === 'query_by_agent' && c.implemented)).toBe(true);
  });

  it('supports discovery over JSON-RPC', async () => {
    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 1,
      method: 'a2a.discover',
    });

    expect(response.error).toBeUndefined();
    const card = response.result as any;
    expect(card.name).toBe('cgraph-a2a-adapter');
  });

  it('write_node persists a node in graph storage', async () => {
    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'write_node',
      params: {
        agent_id: 'agent.alpha',
        name: 'claimNode',
        kind: 'variable',
        doc: 'A2A write path smoke check',
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.node_id).toBeGreaterThan(0);
    expect(result.trust_status).toBe('unverified');

    const db = await GraphDB.open(getDbPath(tempDir));
    try {
      const nodes = db.findNodesByName('claimNode');
      expect(nodes.length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('read_lineage returns ancestors for a node', async () => {
    const parentResponse = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'lineage-parent',
      method: 'write_node',
      params: {
        agent_id: 'agent.alpha',
        name: 'lineageParent',
        qualified_name: 'a2a/lineage::lineageParent',
      },
    });
    expect(parentResponse.error).toBeUndefined();

    const childResponse = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'lineage-child',
      method: 'write_node',
      params: {
        agent_id: 'agent.alpha',
        name: 'lineageChild',
        qualified_name: 'a2a/lineage::lineageChild',
        parent_qname: 'a2a/lineage::lineageParent',
      },
    });
    expect(childResponse.error).toBeUndefined();

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 9,
      method: 'read_lineage',
      params: { qualified_name: 'a2a/lineage::lineageChild' },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.nodes.some((n: any) => n.qualified_name === 'a2a/lineage::lineageParent')).toBe(true);
  });

  it('query_by_agent returns authored nodes for a registered agent', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'demo' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-query',
      method: 'register_agent',
      params: {
        agent_id: 'agent.query',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'query-write',
      method: 'write_node',
      params: {
        agent_id: 'agent.query',
        name: 'agentQueryNode',
      },
    });

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'query-agent',
      method: 'query_by_agent',
      params: {
        agent_id: 'agent.query',
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.registration_found).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.nodes.some((n: any) => n.name === 'agentQueryNode')).toBe(true);
  });

  it('persists concurrent write_node requests without dropping records', async () => {
    const writes = Array.from({ length: 25 }, (_, i) => handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: `concurrent-${i}`,
      method: 'write_node',
      params: {
        agent_id: 'agent.concurrent',
        name: `concurrentNode${i}`,
        qualified_name: `a2a/concurrent::node${i}`,
      },
    }));

    const responses = await Promise.all(writes);
    expect(responses.every(r => !r.error)).toBe(true);

    const db = await GraphDB.open(getDbPath(tempDir));
    try {
      for (let i = 0; i < 25; i++) {
        const node = db.findNodeByQName(`a2a/concurrent::node${i}`);
        expect(node).toBeDefined();
      }
    } finally {
      db.close();
    }
  }, 15_000);

  it('rejects read endpoints when an auth token is configured but the header is missing', async () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({ a2a: { authToken: 'demo-secret' } }));

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'auth-missing',
      method: 'query_by_agent',
      params: { agent_id: 'agent.auth' },
    });

    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain('Authentication required');
  });

  it('accepts read endpoints when the matching auth token header is provided', async () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({ a2a: { authToken: 'demo-secret' } }));

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'auth-present',
      method: 'query_by_agent',
      params: { agent_id: 'agent.auth' },
    }, {
      headers: { 'x-cgraph-a2a-token': 'demo-secret' },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.agent_id).toBe('agent.auth');
    expect(result.count).toBe(0);
  });

  it('revoke_agent marks a registration as revoked and future writes carry revoked trust status', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'revoke' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-revoke',
      method: 'register_agent',
      params: {
        agent_id: 'agent.revoke',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    const revoked = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'revoke-1',
      method: 'revoke_agent',
      params: {
        agent_id: 'agent.revoke',
        reason: 'security_event',
      },
    });
    expect(revoked.error).toBeUndefined();
    expect((revoked.result as any).trust_status).toBe('revoked');

    const writeAfterRevoke = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'write-after-revoke',
      method: 'write_node',
      params: {
        agent_id: 'agent.revoke',
        name: 'revokedNode',
      },
    });

    expect(writeAfterRevoke.error).toBeUndefined();
    expect((writeAfterRevoke.result as any).trust_status).toBe('revoked');
  });

  it('marks registration as expired after registration TTL elapses', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'ttl' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const registered = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-ttl',
      method: 'register_agent',
      params: {
        agent_id: 'agent.ttl',
        claim,
        signature,
        public_key: publicKeyPem,
        registration_ttl_ms: 1,
      },
    }, {
      nowMs: 1000,
    });
    expect(registered.error).toBeUndefined();

    const writeAfterExpiry = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'write-after-expiry',
      method: 'write_node',
      params: {
        agent_id: 'agent.ttl',
        name: 'ttlNode',
      },
    }, {
      nowMs: 1002,
    });

    expect(writeAfterExpiry.error).toBeUndefined();
    expect((writeAfterExpiry.result as any).trust_status).toBe('expired');
  });

  it('enforces configured request rate limits per client key', async () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({
      a2a: {
        rateLimitMaxRequests: 2,
        rateLimitWindowMs: 1000,
      },
    }));

    const first = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'rl-1',
      method: 'a2a.discover',
    }, { clientKey: 'test-client', nowMs: 10 });
    expect(first.error).toBeUndefined();

    const second = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'rl-2',
      method: 'a2a.discover',
    }, { clientKey: 'test-client', nowMs: 20 });
    expect(second.error).toBeUndefined();

    const third = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'rl-3',
      method: 'a2a.discover',
    }, { clientKey: 'test-client', nowMs: 30 });

    expect(third.error).toBeDefined();
    expect(third.error?.code).toBe(-32029);
    expect(third.error?.message).toContain('Rate limit exceeded');
  });

  it('rejects oversized JSON request bodies', async () => {
    const stream = new PassThrough();
    const hugePayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'a2a.discover',
      params: {
        payload: 'x'.repeat(2 * 1024 * 1024),
      },
    });

    const promise = readJsonBody(stream as any, 1024);
    stream.write(hugePayload);
    stream.end();

    await expect(promise).rejects.toThrow('Request body too large');
  });

  it('returns method-not-found for unknown RPC methods', async () => {
    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 9,
      method: 'not_real_method',
    });

    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain('Method not found');
  });

  it('register_agent accepts a valid Ed25519 signed claim', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'demo' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-1',
      method: 'register_agent',
      params: {
        agent_id: 'agent.verified',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.registered).toBe(true);
    expect(result.trust_status).toBe('verified');
  });

  it('register_agent rejects an invalid signature', async () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-2',
      method: 'register_agent',
      params: {
        agent_id: 'agent.invalid',
        claim: '{"capabilities":["write_node"]}',
        signature: Buffer.from('not-valid-signature').toString('base64'),
        public_key: publicKeyPem,
      },
    });

    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain('Signature verification failed');
  });

  it('write_node reports verified trust status for registered agents', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'demo' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-3',
      method: 'register_agent',
      params: {
        agent_id: 'agent.verified.write',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'write-verified',
      method: 'write_node',
      params: {
        agent_id: 'agent.verified.write',
        name: 'trustedNode',
        kind: 'variable',
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.trust_status).toBe('verified');
  });

  it('write_node enforces per_write trust mode when signature material is missing', async () => {
    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'per-write-missing',
      method: 'write_node',
      params: {
        trust_mode: 'per_write',
        agent_id: 'agent.perwrite',
        name: 'perWriteNode',
      },
    });

    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain('per_write trust mode requires');
  });

  it('write_node can use per_write trust mode with valid inline signature', async () => {
    fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({ a2a: { maxVerifyLatencyMs: 10_000 } }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'inline' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'per-write-ok',
      method: 'write_node',
      params: {
        trust_mode: 'per_write',
        agent_id: 'agent.perwrite.ok',
        name: 'perWriteVerified',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.trust_mode_applied).toBe('per_write');
    expect(result.trust_status).toBe('verified');
  });

  it('write_node falls back to registration_only when verification exceeds latency budget', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const claim = JSON.stringify({ capabilities: ['write_node'], scope: 'fallback' });
    const signature = crypto.sign(null, Buffer.from(claim, 'utf-8'), privateKey).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'reg-fallback',
      method: 'register_agent',
      params: {
        agent_id: 'agent.fallback',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    const response = await handleA2ARpcRequest(tempDir, {
      jsonrpc: '2.0',
      id: 'per-write-fallback',
      method: 'write_node',
      params: {
        trust_mode: 'per_write',
        max_verify_latency_ms: -1,
        allow_verify_fallback: true,
        agent_id: 'agent.fallback',
        name: 'fallbackNode',
        claim,
        signature,
        public_key: publicKeyPem,
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as any;
    expect(result.fallback_triggered).toBe(true);
    expect(result.trust_mode_applied).toBe('registration_only');
    expect(result.trust_status).toBe('verified');
  });
});
