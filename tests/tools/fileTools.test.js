// tests/tools/fileTools.test.js — File management tool tests
const path = require('path');
const fs = require('fs');

const writeFile = require('../../server/tools/writeFile');
const readFile = require('../../server/tools/readFile');
const listFiles = require('../../server/tools/listFiles');
const findFile = require('../../server/tools/findFile');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');
const TEST_DIR = path.join(WORKSPACE_DIR, '__test__');

describe('file tools', () => {
  beforeAll(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('write_file', () => {
    it('should create a new file', async () => {
      const result = await writeFile.execute({
        filepath: '__test__/hello.txt',
        content: 'Hello, World!',
      });
      expect(result.error).toBeUndefined();
      expect(result.filepath).toBe('__test__/hello.txt');
      expect(result.action).toBe('created');
    });

    it('should overwrite existing files', async () => {
      await writeFile.execute({ filepath: '__test__/overwrite.txt', content: 'first' });
      const result = await writeFile.execute({ filepath: '__test__/overwrite.txt', content: 'second' });
      expect(result.error).toBeUndefined();
      expect(result.action).toBe('updated');
    });

    it('should block path traversal', async () => {
      const result = await writeFile.execute({
        filepath: '../../etc/passwd',
        content: 'hacked',
      });
      expect(result.error).toContain('outside workspace');
    });

    it('should report line count and bytes', async () => {
      const result = await writeFile.execute({ filepath: '__test__/lines.txt', content: 'a\nb\nc' });
      expect(result.lines).toBe(3);
      expect(result.bytes).toBe(5);
    });
  });

  describe('read_file', () => {
    it('should read an existing file', async () => {
      await writeFile.execute({ filepath: '__test__/readable.txt', content: 'test content' });
      const result = await readFile.execute({ filepath: '__test__/readable.txt' });
      expect(result.content).toBe('test content');
    });

    it('should return error for non-existent file', async () => {
      const result = await readFile.execute({ filepath: '__test__/nope.txt' });
      expect(result.error).toContain('not found');
    });

    it('should block path traversal', async () => {
      const result = await readFile.execute({ filepath: '../../etc/passwd' });
      expect(result.error).toContain('outside workspace');
    });
  });

  describe('list_files', () => {
    it('should list files in a directory', async () => {
      await writeFile.execute({ filepath: '__test__/a.txt', content: 'a' });
      await writeFile.execute({ filepath: '__test__/b.txt', content: 'b' });
      const result = await listFiles.execute({ directory: '__test__' });
      expect(result.entries).toBeDefined();
      expect(result.entries.length).toBeGreaterThanOrEqual(2);
    });

    it('should block path traversal', async () => {
      const result = await listFiles.execute({ directory: '../../../' });
      expect(result.error).toContain('outside workspace');
    });
  });

  describe('find_file', () => {
    it('should find files by name', async () => {
      await writeFile.execute({ filepath: '__test__/search/found.js', content: 'found' });
      const result = await findFile.execute({ filename: 'found.js', directory: '__test__' });
      expect(result.matches).toBeDefined();
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
    });
  });
});
