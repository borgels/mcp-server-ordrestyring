import { OrdrestyringClient } from '../src/ordrestyring/client.js';

async function main(): Promise<void> {
  const client = new OrdrestyringClient();
  const result = await client.graphql<{ __typename: string }>({
    query: 'query OrdrestyringMcpLiveSmoke { __typename }',
  });

  console.log(JSON.stringify({ ok: true, typename: result.__typename }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
