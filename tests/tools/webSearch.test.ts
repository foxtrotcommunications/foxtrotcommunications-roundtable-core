import webSearch from '../../server/tools/webSearch';

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ Abstract: 'Duck test', Heading: 'Duck result' })
  })
) as jest.Mock;

describe('webSearch tool', () => {
  it('should execute successfully', async () => {
    const result = await webSearch.execute({ query: 'test' });
    expect(result).toBeDefined();
  });
});
