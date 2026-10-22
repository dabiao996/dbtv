import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackLoadingState} from '../../client/src/playback-loading-state';

test('playback loading distinguishes buffering, connecting and failure without false progress claims',()=>{
  assert.deepEqual(playbackLoadingState('正在缓冲视频…'),{failed:false,hint:'正在准备接下来的画面'});
  assert.equal(playbackLoadingState('正在获取播放线路…').hint,'正在读取可用播放线路');
  assert.equal(playbackLoadingState('正在连接视频源…').failed,false);
  for(const stage of ['当前线路响应较慢，请尝试切换线路','读取播放源失败，请返回详情重新选择','播放错误'])assert.deepEqual(playbackLoadingState(stage),{failed:true,hint:'可返回详情，或在下方切换其他线路'});
});
