import { loadFixture, evaluateFixture } from './fixture-demo.mjs';

const { warning, snapshot, incident, decision } = evaluateFixture(loadFixture());
console.log(JSON.stringify({ warning,
  graph: process.argv.includes('--graph') ? snapshot : { nodes: snapshot.nodes.length, edges: snapshot.edges.length },
  incident, decision }, null, 2));
