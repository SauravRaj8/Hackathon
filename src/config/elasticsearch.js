import { Client } from '@elastic/elasticsearch';

export const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  sniffOnStart: false,
  sniffOnConnectionFault: false,
});

export const checkESHealth = async () => {
  try {
    const { body: health } = await esClient.cluster.health();
    console.log(`[Elasticsearch] Status: ${health.status}`);
    return true;
  } catch (err) {
    console.error('[Elasticsearch] Connection failed:', err.message);
    return false;
  }
};
