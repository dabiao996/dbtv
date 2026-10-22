export function playbackLoadingState(stage:string){
  const failed=/失败|较慢|错误/.test(stage);
  const hint=failed?'可返回详情，或在下方切换其他线路':stage.includes('缓冲')?'正在准备接下来的画面':stage.includes('获取')?'正在读取可用播放线路':'连接就绪后将继续播放';
  return {failed,hint};
}
