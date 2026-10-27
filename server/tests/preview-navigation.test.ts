import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldOpenPreviewDetails} from '../../client/src/cinema/preview-navigation';

const click={button:0,defaultPrevented:false,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,fromControl:false,hasSelection:false};
test('preview background clicks open details, but nested controls and text selection do not',()=>{
  assert.equal(shouldOpenPreviewDetails(click),true);
  for(const key of ['defaultPrevented','ctrlKey','metaKey','shiftKey','altKey','fromControl','hasSelection'])assert.equal(shouldOpenPreviewDetails({...click,[key]:true}),false,key);
  for(const button of [1,2])assert.equal(shouldOpenPreviewDetails({...click,button}),false);
});
