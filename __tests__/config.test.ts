import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_CONFIG, estimateTokens, detectLanguage, loadConfig, getDbPath } from '../src/config';

function createTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-config-test-')); }

describe('config', () => {
  describe('DEFAULT_CONFIG', () => {
    it('has extensions array', () => {
      expect(Array.isArray(DEFAULT_CONFIG.extensions)).toBe(true);
      expect(DEFAULT_CONFIG.extensions.length).toBeGreaterThan(0);
    });

    it('has ignorePaths array', () => {
      expect(Array.isArray(DEFAULT_CONFIG.ignorePaths)).toBe(true);
    });

    it('has positive maxNodes', () => {
      expect(DEFAULT_CONFIG.maxNodes).toBeGreaterThan(0);
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns positive value for non-empty string', () => {
      expect(estimateTokens('hello world foo bar')).toBeGreaterThan(0);
    });

    it('longer text has more tokens', () => {
      const short = estimateTokens('hi');
      const long  = estimateTokens('hi '.repeat(100));
      expect(long).toBeGreaterThan(short);
    });
  });

  describe('detectLanguage', () => {
    it('detects TypeScript', () => {
      expect(detectLanguage('src/foo.ts')).toBe('typescript');
    });

    it('detects JavaScript', () => {
      expect(detectLanguage('src/foo.js')).toBe('javascript');
    });

    it('detects Python', () => {
      expect(detectLanguage('app.py')).toBe('python');
    });

    it('returns null for unknown extension', () => {
      expect(detectLanguage('README.xyz')).toBeNull();
    });
  });

  describe('getDbPath', () => {
    it('returns a string path', () => {
      const p = getDbPath('/some/dir');
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });

  describe('loadConfig', () => {
    let tempDir: string;
    afterEach(() => { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

    it('returns defaults when no config file exists', () => {
      tempDir = createTempDir();
      const cfg = loadConfig(tempDir);
      expect(cfg).toHaveProperty('extensions');
      expect(cfg).toHaveProperty('ignorePaths');
    });

    it('merges user config over defaults', () => {
      tempDir = createTempDir();
      fs.writeFileSync(path.join(tempDir, '.cgraph.json'), JSON.stringify({ maxNodes: 999 }));
      const cfg = loadConfig(tempDir);
      expect(cfg.maxNodes).toBe(999);
    });
  });
});
