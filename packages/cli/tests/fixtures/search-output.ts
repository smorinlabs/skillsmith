import { buildProgram } from '../../src/program.ts';

// The production dispatcher, application, codec, renderer, and process IO remain real.
// Only the provider is replaced, so this fixture needs no network or local skill state.
const program = buildProgram(undefined, {
  search: { provider: { search: async (request) => ({ ok: true, value: {
    provider: 'skills.sh', query: request.query, owner: request.owner, limit: request.limit,
    returned: 20, searchType: 'unknown',
    results: Array.from({ length: 20 }, (_, index) => ({
      kind: 'skill', catalogId: `fixture/skills/item-${index}`, providerSkillId: null,
      name: `${index}:${'é'.repeat(32_768)}`, source: 'fixture/skills', installs: null,
      url: `https://skills.sh/fixture/skills/item-${index}`, verification: 'not-checked',
    })),
  } }) } },
});
await program.parseAsync(process.argv);
