import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkedHistorySeeds,unresolvedHistorySeeds} from './history-freshness.ts';
import {convertXDiscovery} from './x-intake.ts';
import {nativeXSourceIssue} from './x-source.ts';
import type {XAvailabilityState} from './x-availability.ts';
const capturedAt='2026-10-17T00:00:00.000Z',now='2026-10-19T00:00:00.000Z';
function fixture(){return convertXDiscovery([{name:'synthetic',data:{provider:'twitterapi',capturedAt,posts:[{id:'123',author_id:'9',created_at:capturedAt,text:'Image prompt:\nCreate an original watercolor landscape with soft morning light and a quiet mountain lake.',attachments:{media_keys:['photo']}}],media:[{media_key:'photo',type:'photo',url:'https://pbs.twimg.com/media/synthetic.jpg'}],creators:[{id:'x-9',externalID:'9',platform:'x',username:'fixture',displayName:'Fixture',profileURL:'https://x.com/fixture'}]}}]).candidates[0];}
test('verified seed recheck refreshes only a copy and preserves frozen source and approval revision',()=>{
 const item=fixture(),before=structuredClone(item);assert.ok(nativeXSourceIssue(item,Date.parse(now)));const state:XAvailabilityState={[item.id]:{status:'ready',checkedAt:now,checkedBy:'twitterapi',revision:item.source.revision}};
 const [fresh]=checkedHistorySeeds([item],state,Date.parse(now));assert.equal(nativeXSourceIssue(fresh,Date.parse(now)),undefined);assert.equal(fresh.source.revision,item.source.revision);assert.deepEqual(item,before);assert.equal(item.source.post!.checkedAt,capturedAt);
});
test('missing evidence never renews a seed; invalid or withheld checks fail closed',()=>{
 const item=fixture();assert.equal(checkedHistorySeeds([item],{},Date.parse(now))[0],item);
 const valid:XAvailabilityState[string]={status:'ready',checkedAt:now,checkedBy:'twitterapi',revision:item.source.revision};
 for(const change of [{status:'withheld' as const},{revision:'b'.repeat(64)},{checkedAt:capturedAt},{checkedAt:'2026-10-20T00:00:00.000Z'},{checkedBy:'official' as const}])assert.deepEqual(checkedHistorySeeds([item],{[item.id]:{...valid,...change}},Date.parse(now)),[]);
});
test('thread seed cannot reuse a standalone provider check',()=>{
 const item=fixture();item.source.post!.parentID='122';item.source.mediaPostID='123';item.source.context=[{...item.source.post!,id:'122',parentID:undefined}];
 assert.deepEqual(checkedHistorySeeds([item],{[item.id]:{status:'ready',checkedAt:now,checkedBy:'twitterapi',revision:item.source.revision}},Date.parse(now)),[]);
});

test('explicit seed holds reduce eligible count but unknown expiry remains a blocker',()=>{
 const item=fixture();assert.deepEqual(unresolvedHistorySeeds([item],[],{},new Set()),[item.id]);
 assert.deepEqual(unresolvedHistorySeeds([item],[],{},new Set([item.id])),[]);
 assert.deepEqual(unresolvedHistorySeeds([item],[],{[item.id]:{status:'withheld',checkedAt:now,checkedBy:'twitterapi'}},new Set()),[]);
 assert.deepEqual(unresolvedHistorySeeds([item],[item],{},new Set()),[]);
});
