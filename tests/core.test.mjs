import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedPaths, validateSnapshot } from '../dist/core/graph.js';
import { simulate } from '../dist/core/simulator.js';
import { decide } from '../dist/core/decision.js';
const ev = {status:'verified',sourceType:'fixture',reference:'test',observedAt:'2026-10-11T00:00:00Z'};
const graph = { snapshotId:'test',rootPositionId:'position',rootPositionUsd:10000,chainId:1,observedAt:'2026-10-11T00:00:00Z',mode:'fixture',
 nodes:[{id:'position',kind:'position',label:'position'},{id:'vault',kind:'vault',label:'vault'},{id:'market',kind:'lending_market',label:'market'},{id:'oracle',kind:'oracle',label:'oracle'},{id:'chain',kind:'chain',label:'chain'}],
 edges:[{id:'1',from:'position',to:'vault',kind:'HOLDS_SHARES_IN',evidence:ev},{id:'2',from:'vault',to:'market',kind:'ALLOCATES_TO',allocationBps:6000,evidence:ev},{id:'3',from:'market',to:'oracle',kind:'USES_ORACLE',evidence:ev},{id:'4',from:'vault',to:'chain',kind:'SETTLES_ON',evidence:ev}]};
test('snapshot schema references are valid',()=> assert.deepEqual(validateSnapshot(graph),[]));
test('reverse dependency traversal reaches the position',()=> assert.deepEqual(affectedPaths(graph,'oracle'),[['oracle','market','vault','position']]));
test('loss simulator only multiplies verified capital allocations',()=> {
 const scenario={id:'s',kind:'MARKET_LOSS',targetNodeId:'market',severityFraction:.2,horizonHours:24,probabilityWithinHorizon:.25};
 const result=simulate(graph,scenario);
 assert.equal(result.incrementalLossIfStayingUsd,1200);
 assert.equal(decide(result,scenario,200).action,'EXIT');
 assert.equal(decide(result,{...scenario,probabilityWithinHorizon:undefined},200).action,'INSUFFICIENT_EVIDENCE');
});
test('oracle incident cannot magically create a dollar loss',()=> {
 const scenario={id:'s',kind:'ORACLE_STALE',targetNodeId:'oracle',horizonHours:24};
 const result=simulate(graph,scenario);
 assert.equal(result.incrementalLossIfStayingUsd,null);
 assert.equal(decide(result,scenario,100).action,'INSUFFICIENT_EVIDENCE');
});
test('chain outage blocks exit recommendations',()=> {
 const scenario={id:'s',kind:'CHAIN_OUTAGE',targetNodeId:'chain',horizonHours:2};
 const result=simulate(graph,scenario);
 assert.equal(decide(result,scenario,10).action,'EXIT_UNAVAILABLE');
});
test('dangling edges are rejected',()=> {
 assert.ok(validateSnapshot({...graph,edges:[...graph.edges,{id:'5',from:'unknown',to:'vault',kind:'USES_CONTRACT',evidence:ev}]}).length>0);
});
