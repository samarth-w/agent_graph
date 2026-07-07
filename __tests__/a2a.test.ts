import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { getAgentCard, handleA2ARpcRequest } from '../src/a2a';
import { GraphDB } from '../src/storage';
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
