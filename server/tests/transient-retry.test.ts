import test from 'node:test';
import assert from 'node:assert/strict';
import {withTransientRetry} from '../src/installation.js';

// Inject a failure at the query boundary, including after a simulated commit.
// This exercises the actual Prisma extension callback without a live database.
function retryQuery(){
  let callback:any;
  const extended={};
  assert.equal(withTransientRetry({$extends(extension:any){callback=extension.query.$allOperations;return extended;}}),extended);
  return callback;
}
const failure=(code:string)=>Object.assign(new Error(code),{code});

test('ambiguous committed writes are never replayed',async()=>{
  for(const code of ['P1001','P1002','P1008','P2024','P2028','P2034']){
    for(const operation of ['create','createMany','createManyAndReturn','update','updateMany','updateManyAndReturn','upsert','delete','deleteMany']){
      const error=failure(code),args={data:{balanceCents:{increment:100}}};let calls=0,balance=0;
      await assert.rejects(retryQuery()({model:'Wallet',operation,args,query:async(actual:any)=>{
        assert.equal(actual,args);calls++;balance+=100;throw error;
      }}),(actual:unknown)=>actual===error);
      assert.equal(calls,1,`${operation}/${code}`);assert.equal(balance,100);
    }
  }
});

test('raw SQL and unknown operations are never replayed, even when named like reads',async()=>{
  for(const operation of ['$queryRaw','$queryRawUnsafe','$executeRaw','$executeRawUnsafe','findRaw','aggregateRaw','futureOperation']){
    let calls=0;const error=failure('P1008');
    await assert.rejects(retryQuery()({model:operation.startsWith('$')?undefined:'User',operation,args:{},query:async()=>{calls++;throw error;}}),(actual:unknown)=>actual===error);
    assert.equal(calls,1,operation);
  }
  let calls=0;const error=failure('P1008');
  await assert.rejects(retryQuery()({operation:'findMany',args:{},query:async()=>{calls++;throw error;}}));
  assert.equal(calls,1,'a model must be present');
});

test('known model reads recover from transient errors with at most three attempts',async()=>{
  for(const operation of ['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany','count','aggregate','groupBy']){
    let calls=0;const result={ok:true},args={where:{id:1}};
    assert.equal(await retryQuery()({model:'User',operation,args,query:async(actual:any)=>{
      assert.equal(actual,args);if(++calls<3)throw failure('P1008');return result;
    }}),result);
    assert.equal(calls,3,operation);
  }
  for(const code of ['P1001','P1002','P1008','P2024']){
    let calls=0;const error=failure(code);
    await assert.rejects(retryQuery()({model:'User',operation:'count',args:{},query:async()=>{calls++;throw error;}}),(actual:unknown)=>actual===error);
    assert.equal(calls,3,code);
  }
});

test('transaction failures and nontransient read errors propagate without retry',async()=>{
  for(const code of ['P2028','P2034','P2002','P2021','UNKNOWN']){
    let calls=0;const error=failure(code);
    await assert.rejects(retryQuery()({model:'User',operation:'findMany',args:{},query:async()=>{calls++;throw error;}}),(actual:unknown)=>actual===error);
    assert.equal(calls,1,code);
  }
});
